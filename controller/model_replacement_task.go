package controller

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/MoeForge/moego/ojson"
	"github.com/samber/lo"
)

const (
	// modelReplacementRecordRetention bounds how long per-channel detection
	// history is kept for the report.
	modelReplacementRecordRetention = 7 * 24 * time.Hour
	modelReplacementStoredTextLimit = 2000
)

// modelReplacementDisableReasons are stored as the channel status reason when
// an action disables a channel, keyed by verdict. The console translates them.
var modelReplacementDisableReasons = map[string]string{
	model.ModelReplacementVerdictPassed:   "Disabled by a model replacement detection action",
	model.ModelReplacementVerdictReplaced: "Model replacement detection found a replaced model",
	model.ModelReplacementVerdictFailed:   "Model replacement detection requests failed after all retries",
}

// modelReplacementTaskPayload marks a run triggered from the report page.
type modelReplacementTaskPayload struct {
	Manual             bool  `json:"manual,omitempty"`
	ChannelID          int   `json:"channel_id,omitempty"`
	ResumeAfterSeconds int64 `json:"resume_after_seconds,omitempty"`
}

// modelReplacementRunSummary is persisted as the system task result.
type modelReplacementRunSummary struct {
	StartedAt  int64 `json:"started_at"`
	FinishedAt int64 `json:"finished_at"`
	Manual     bool  `json:"manual"`
	Channels   int   `json:"channels"`
	Passed     int   `json:"passed"`
	Replaced   int   `json:"replaced"`
	Failed     int   `json:"failed"`
}

// modelReplacementHandler schedules detection runs. The scheduler measures
// the interval from the previous run's last update, so the wait for the next
// run starts after every round of the previous run has finished, and the
// interval is the one configured for the time of day that run finished.
type modelReplacementHandler struct{}

func (modelReplacementHandler) Type() string { return model.SystemTaskTypeModelReplacementDetection }

func (modelReplacementHandler) Enabled() bool {
	return operation_setting.GetModelReplacementSetting().Enabled
}

func (modelReplacementHandler) Interval() time.Duration {
	return time.Duration(operation_setting.GetModelReplacementSetting().IntervalMinutes) * time.Minute
}

// IntervalAfter picks the wait from the time window the previous run finished
// in, so a run that ends at night waits for the night interval.
func modelReplacementIntervalAfter(task *model.SystemTask, setting operation_setting.ModelReplacementSetting, finishedAt time.Time) time.Duration {
	var payload modelReplacementTaskPayload
	if task != nil && task.DecodePayload(&payload) == nil && payload.ChannelID > 0 {
		return time.Duration(max(payload.ResumeAfterSeconds, 0)) * time.Second
	}
	return setting.IntervalAt(finishedAt)
}

func (modelReplacementHandler) IntervalAfter(task *model.SystemTask, finishedAt time.Time) time.Duration {
	return modelReplacementIntervalAfter(task, operation_setting.GetModelReplacementSetting(), finishedAt)
}

func modelReplacementNextRunAt(setting operation_setting.ModelReplacementSetting, latest *model.SystemTask, now time.Time) int64 {
	if latest == nil {
		return now.Unix()
	}
	finishedAt := time.Unix(latest.UpdatedAt, 0)
	return max(now.Unix(), latest.UpdatedAt+int64(modelReplacementIntervalAfter(latest, setting, finishedAt).Seconds()))
}

func (modelReplacementHandler) NewPayload() any { return nil }

func (modelReplacementHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	payload := modelReplacementTaskPayload{}
	if err := task.DecodePayload(&payload); err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, nil, err)
		return
	}
	summary, err := runModelReplacementDetection(ctx, task.TaskID, payload.Manual, payload.ChannelID, service.NewSystemTaskProgressReporter(task, runnerID))
	if err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, err)
		return
	}
	finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusSucceeded, summary, nil)
}

// modelReplacementTarget is one channel and the detected models it serves,
// with the attempts collected for it during a run. A target is handled by one
// worker at a time, so its requests are always sequential.
type modelReplacementTarget struct {
	channel    *model.Channel
	models     []operation_setting.ModelReplacementModelSetting
	attempts   []model.ModelReplacementAttempt
	failed     bool
	startedAt  int64
	finishedAt int64
}

// selectModelReplacementTargets returns the enabled channels that serve at
// least one detected model and are not excluded for it. Disabled channels are
// skipped by automatic runs; an explicit channel retest may probe them without
// changing their disabled state.
func selectModelReplacementTargets(setting operation_setting.ModelReplacementSetting, channels []*model.Channel, channelID int) []*modelReplacementTarget {
	targets := make([]*modelReplacementTarget, 0)
	for _, channel := range channels {
		if channel == nil || channelID > 0 && channel.Id != channelID || channelID == 0 && channel.Status != common.ChannelStatusEnabled || slices.Contains(unsupportedTestChannelTypes, channel.Type) {
			continue
		}
		channelModels := channel.GetModels()
		for i := range channelModels {
			channelModels[i] = strings.TrimSpace(channelModels[i])
		}
		target := &modelReplacementTarget{channel: channel}
		for _, item := range setting.Models {
			if slices.Contains(channelModels, item.Model) && !slices.Contains(item.ExcludedChannelIDs, channel.Id) {
				target.models = append(target.models, item)
			}
		}
		if len(target.models) > 0 {
			targets = append(targets, target)
		}
	}
	slices.SortFunc(targets, func(a, b *modelReplacementTarget) int { return a.channel.Id - b.channel.Id })
	return targets
}

func runModelReplacementDetection(ctx context.Context, runID string, manual bool, channelID int, report func(processed, total int)) (modelReplacementRunSummary, error) {
	setting := operation_setting.GetModelReplacementSetting()
	summary := modelReplacementRunSummary{StartedAt: common.GetTimestamp(), Manual: manual}
	if !setting.Enabled {
		return summary, errors.New("model replacement detection is disabled")
	}
	testUserID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return summary, err
	}
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		return summary, err
	}

	targets := selectModelReplacementTargets(setting, channels, channelID)
	if channelID > 0 && len(targets) == 0 {
		return summary, fmt.Errorf("channel #%d does not provide a configured detection model", channelID)
	}
	timeout := time.Duration(setting.TimeoutSeconds) * time.Second
	total := len(targets) * setting.Rounds
	processed := 0
	report(processed, total)

	for round := 1; round <= setting.Rounds; round++ {
		active := make([]*modelReplacementTarget, 0, len(targets))
		for _, target := range targets {
			if !target.failed {
				active = append(active, target)
			}
		}
		processed += len(targets) - len(active)

		jobs := make(chan *modelReplacementTarget)
		done := make(chan struct{})
		var workers sync.WaitGroup
		for range min(setting.Concurrency, max(len(active), 1)) {
			workers.Go(func() {
				for target := range jobs {
					probeModelReplacementTarget(ctx, target, round, testUserID, timeout)
					done <- struct{}{}
				}
			})
		}
		go func() {
			defer close(jobs)
			for _, target := range active {
				select {
				case <-ctx.Done():
					return
				case jobs <- target:
				}
			}
		}()
		go func() {
			workers.Wait()
			close(done)
		}()
		for range done {
			processed++
			report(processed, total)
		}
		if ctx.Err() != nil {
			return summary, ctx.Err()
		}
	}

	cacheChanged := false
	for _, target := range targets {
		stats, verdict, matchPercent := summarizeModelReplacementAttempts(target.models, target.attempts, setting.Threshold)
		var actions []operation_setting.ModelReplacementAction
		switch verdict {
		case model.ModelReplacementVerdictPassed:
			actions = setting.PassActions
		case model.ModelReplacementVerdictReplaced:
			actions = setting.FailActions
		case model.ModelReplacementVerdictFailed:
			actions = setting.RequestFailureActions
		}
		applied, changed, applyErr := applyModelReplacementActions(target.channel, verdict, actions)
		cacheChanged = cacheChanged || changed

		record := &model.ModelReplacementRecord{
			RunID:        runID,
			ChannelID:    target.channel.Id,
			ChannelName:  target.channel.Name,
			Verdict:      verdict,
			MatchPercent: matchPercent,
			StartedAt:    target.startedAt,
			FinishedAt:   target.finishedAt,
		}
		if applyErr != nil {
			record.ErrorMessage = applyErr.Error()
			common.SysError(common.LogText("model replacement detection failed to update channel #%d: %v", target.channel.Id, applyErr))
		}
		if encoded, err := common.Marshal(stats); err == nil {
			record.ModelStats = string(encoded)
		}
		if encoded, err := common.Marshal(applied); err == nil {
			record.Actions = string(encoded)
		}
		var latencyTotal int64
		for _, attempt := range target.attempts {
			latencyTotal += attempt.LatencyMs
		}
		if len(target.attempts) > 0 {
			record.AvgLatencyMs = latencyTotal / int64(len(target.attempts))
		}
		if err := model.CreateModelReplacementRecord(record, target.attempts); err != nil {
			common.SysError(common.LogText("model replacement detection failed to save channel #%d: %v", target.channel.Id, err))
		}

		summary.Channels++
		switch verdict {
		case model.ModelReplacementVerdictPassed:
			summary.Passed++
		case model.ModelReplacementVerdictReplaced:
			summary.Replaced++
		default:
			summary.Failed++
		}
	}
	if cacheChanged {
		model.InitChannelCache()
	}
	if err := model.PurgeModelReplacementRecords(time.Now().Add(-modelReplacementRecordRetention).Unix()); err != nil {
		common.SysError(common.LogText("model replacement detection failed to delete old records: %v", err))
	}
	summary.FinishedAt = common.GetTimestamp()
	return summary, nil
}

// probeModelReplacementTarget runs one round for a channel: every detected
// model once, in order. A model that still fails after its retries marks the
// channel failed and skips the rest of the channel's requests.
func probeModelReplacementTarget(ctx context.Context, target *modelReplacementTarget, round int, testUserID int, timeout time.Duration) {
	for _, item := range target.models {
		if ctx.Err() != nil {
			return
		}
		attempt := model.ModelReplacementAttempt{Model: item.Model, Round: round, TestedAt: common.GetTimestamp()}
		if target.startedAt == 0 {
			target.startedAt = attempt.TestedAt
		}
		for try := 0; try <= item.RetryTimes && ctx.Err() == nil; try++ {
			attempt.Tries = try + 1
			endpointType, isStream, request := buildModelReplacementProbe(target.channel, item)
			attemptCtx, cancel := context.WithTimeout(ctx, timeout)
			startedAt := time.Now()
			result := runChannelTest(attemptCtx, target.channel, testUserID, item.Model, endpointType, isStream, request)
			attempt.LatencyMs = time.Since(startedAt).Milliseconds()
			timedOut := errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
			cancel()

			if result.localErr != nil {
				attempt.ErrorMessage = truncateModelReplacementText(result.localErr.Error())
				if timedOut {
					attempt.ErrorMessage = fmt.Sprintf("request timed out after %s", timeout)
				}
				continue
			}
			answer, err := extractModelReplacementAnswer(result.responseBody, isStream)
			if err != nil {
				attempt.ErrorMessage = err.Error()
				continue
			}
			attempt.Success = true
			attempt.Matched = item.AnswerMatches(answer)
			attempt.Answer = truncateModelReplacementText(answer)
			attempt.ErrorMessage = ""
			if result.responseModel != "" && result.responseModel != item.Model {
				attempt.Matched = false
				attempt.ErrorMessage = "The response model does not exactly match the test model."
			}
			break
		}
		target.attempts = append(target.attempts, attempt)
		target.finishedAt = common.GetTimestamp()
		if !attempt.Success {
			target.failed = true
			return
		}
	}
}

// buildModelReplacementProbe asks the detection question through the same
// endpoint the automatic channel test would use for this channel and model.
func buildModelReplacementProbe(channel *model.Channel, item operation_setting.ModelReplacementModelSetting) (string, bool, dto.Request) {
	isCodexChannel := shouldUseStreamForAutomaticChannelTest(channel)
	if isCodexChannel || strings.Contains(strings.ToLower(item.Model), "codex") {
		input, _ := common.Marshal([]map[string]string{{"role": "user", "content": item.Question}})
		return string(constant.EndpointTypeOpenAIResponse), isCodexChannel, &dto.OpenAIResponsesRequest{
			Model:  item.Model,
			Input:  input,
			Stream: lo.ToPtr(isCodexChannel),
		}
	}
	return string(constant.EndpointTypeOpenAI), false, &dto.GeneralOpenAIRequest{
		Model:    item.Model,
		Stream:   lo.ToPtr(false),
		Messages: []dto.Message{{Role: "user", Content: item.Question}},
	}
}

// extractModelReplacementAnswer reads the reply text from a chat completion,
// a Responses result, or either of their event streams.
func extractModelReplacementAnswer(body []byte, isStream bool) (string, error) {
	var answer strings.Builder
	switch {
	case isStream:
		for line := range bytes.SplitSeq(body, []byte{'\n'}) {
			payload, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:"))
			payload = bytes.TrimSpace(payload)
			if !ok || len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
				continue
			}
			switch ojson.GetBytes(payload, "type").String() {
			case "response.output_text.delta":
				answer.WriteString(ojson.GetBytes(payload, "delta").String())
			case "response.completed":
				if answer.Len() == 0 {
					answer.WriteString(responsesOutputText(ojson.GetBytes(payload, "response.output")))
				}
			case "":
				answer.WriteString(ojson.GetBytes(payload, "choices.0.delta.content").String())
			}
		}
	case ojson.GetBytes(body, "output").IsArray():
		answer.WriteString(responsesOutputText(ojson.GetBytes(body, "output")))
	default:
		content := ojson.GetBytes(body, "choices.0.message.content")
		if !content.IsArray() {
			answer.WriteString(content.String())
			break
		}
		for _, part := range content.Array() {
			answer.WriteString(part.Get("text").String())
		}
	}
	text := strings.TrimSpace(answer.String())
	if text == "" {
		return "", errors.New("upstream returned an empty answer")
	}
	return text, nil
}

// responsesOutputText joins the output_text parts of a Responses output list.
func responsesOutputText(output ojson.Result) string {
	var text strings.Builder
	for _, item := range output.Array() {
		for _, part := range item.Get("content").Array() {
			if part.Get("type").String() == "output_text" {
				text.WriteString(part.Get("text").String())
			}
		}
	}
	return text.String()
}

func truncateModelReplacementText(text string) string {
	if utf8.RuneCountInString(text) <= modelReplacementStoredTextLimit {
		return text
	}
	return string([]rune(text)[:modelReplacementStoredTextLimit])
}

// summarizeModelReplacementAttempts computes per-model statistics and the
// channel verdict. A model is replaced when the share of rounds with a wrong
// answer or response model exceeds the threshold percentage. Any request that
// failed after its retries makes the channel failed. matchPercent is the lowest
// model match rate.
func summarizeModelReplacementAttempts(models []operation_setting.ModelReplacementModelSetting, attempts []model.ModelReplacementAttempt, threshold float64) ([]model.ModelReplacementModelStat, string, float64) {
	stats := make([]model.ModelReplacementModelStat, 0, len(models))
	verdict := model.ModelReplacementVerdictPassed
	matchPercent := 100.0
	for _, item := range models {
		stat := model.ModelReplacementModelStat{Model: item.Model}
		for _, attempt := range attempts {
			if attempt.Model != item.Model {
				continue
			}
			stat.Total++
			switch {
			case !attempt.Success:
				stat.Failed++
			case attempt.Matched:
				stat.Matched++
			default:
				stat.Mismatched++
			}
		}
		if stat.Total > 0 {
			stat.MatchPercent = float64(stat.Matched) * 100 / float64(stat.Total)
			stat.MismatchPercent = float64(stat.Mismatched) * 100 / float64(stat.Total)
			matchPercent = min(matchPercent, stat.MatchPercent)
		}
		switch {
		case stat.Failed > 0:
			stat.Verdict = model.ModelReplacementVerdictFailed
			verdict = model.ModelReplacementVerdictFailed
		case stat.Total == 0:
			// Not reached because an earlier model of the channel failed.
		case stat.MismatchPercent > threshold:
			stat.Verdict = model.ModelReplacementVerdictReplaced
			if verdict != model.ModelReplacementVerdictFailed {
				verdict = model.ModelReplacementVerdictReplaced
			}
		default:
			stat.Verdict = model.ModelReplacementVerdictPassed
		}
		stats = append(stats, stat)
	}
	if len(attempts) == 0 {
		matchPercent = 0
	}
	return stats, verdict, matchPercent
}

// rewriteChannelGroups drops the entries named in remove from a
// comma-separated group list and appends add when it is not already listed.
// Every other entry, such as default or vip, is kept exactly as written and
// in its original position.
func rewriteChannelGroups(group string, add string, remove ...string) string {
	entries := make([]string, 0)
	hasAdd := false
	if group != "" {
		for entry := range strings.SplitSeq(group, ",") {
			name := strings.TrimSpace(entry)
			if name != "" && name == add {
				hasAdd = true
			} else if name != "" && slices.Contains(remove, name) {
				continue
			}
			entries = append(entries, entry)
		}
	}
	if add != "" && !hasAdd {
		entries = append(entries, add)
	}
	return strings.Join(entries, ",")
}

// applyModelReplacementActions runs the configured actions on a channel in
// order and writes the result once: group entries other than the ones an
// action names are kept as written, priority, weight, and tag are copied onto
// the channel's abilities, and the last disable action decides the status.
// The channel is reloaded first so edits made during the run are kept, and a
// channel that was disabled or deleted meanwhile is left alone. changed
// reports a write that requires a channel cache refresh.
func applyModelReplacementActions(snapshot *model.Channel, verdict string, actions []operation_setting.ModelReplacementAction) ([]model.ModelReplacementAppliedAction, bool, error) {
	applied := make([]model.ModelReplacementAppliedAction, 0, len(actions))
	channel, err := model.GetChannelById(snapshot.Id, true)
	if err != nil {
		return applied, false, err
	}
	if channel.Status != common.ChannelStatusEnabled {
		return applied, false, nil
	}

	const limit = operation_setting.ModelReplacementRoutingLimit
	group := channel.Group
	priority := channel.GetPriority()
	weight := int64(channel.GetWeight())
	tag := channel.GetTag()
	disableStatus := 0
	for _, action := range actions {
		result := model.ModelReplacementAppliedAction{Type: action.Type, Value: action.Value, Amount: action.Amount}
		switch action.Type {
		case operation_setting.ModelReplacementActionAddGroup:
			next := rewriteChannelGroups(group, action.Value)
			result.Changed = next != group
			group = next
		case operation_setting.ModelReplacementActionRemoveGroup:
			next := rewriteChannelGroups(group, "", action.Value)
			result.Changed = next != group
			group = next
		case operation_setting.ModelReplacementActionIncreasePriority:
			next := min(priority+action.Amount, limit)
			result.Changed = next != priority
			priority = next
		case operation_setting.ModelReplacementActionDecreasePriority:
			next := max(priority-action.Amount, 0)
			result.Changed = next != priority
			priority = next
		case operation_setting.ModelReplacementActionSetPriority:
			result.Changed = action.Amount != priority
			priority = action.Amount
		case operation_setting.ModelReplacementActionIncreaseWeight:
			next := min(weight+action.Amount, limit)
			result.Changed = next != weight
			weight = next
		case operation_setting.ModelReplacementActionDecreaseWeight:
			next := max(weight-action.Amount, 0)
			result.Changed = next != weight
			weight = next
		case operation_setting.ModelReplacementActionSetWeight:
			result.Changed = action.Amount != weight
			weight = action.Amount
		case operation_setting.ModelReplacementActionSetTag:
			result.Changed = action.Value != tag
			tag = action.Value
		case operation_setting.ModelReplacementActionRemoveTag:
			if tag != "" && (action.Value == "" || action.Value == tag) {
				tag = ""
				result.Changed = true
			}
		case operation_setting.ModelReplacementActionAutoDisable:
			disableStatus = common.ChannelStatusAutoDisabled
			result.Changed = true
		case operation_setting.ModelReplacementActionManualDisable:
			disableStatus = common.ChannelStatusManuallyDisabled
			result.Changed = true
		}
		applied = append(applied, result)
	}

	changed := false
	var errs []error
	if group != channel.Group {
		if len(group) > 64 {
			errs = append(errs, fmt.Errorf("group list %q exceeds 64 characters", group))
		} else if err := model.UpdateChannelGroup(channel.Id, group); err != nil {
			errs = append(errs, err)
		} else {
			changed = true
		}
	}
	if priority != channel.GetPriority() || weight != int64(channel.GetWeight()) || tag != channel.GetTag() {
		var tagValue *string
		if tag != "" {
			tagValue = &tag
		}
		if err := model.UpdateChannelRouting(channel.Id, priority, uint(weight), tagValue); err != nil {
			errs = append(errs, err)
		} else {
			changed = true
		}
	}
	reason := modelReplacementDisableReasons[verdict]
	switch disableStatus {
	case common.ChannelStatusAutoDisabled:
		service.DisableChannel(*types.NewChannelError(channel.Id, channel.Type, channel.Name, channel.ChannelInfo.IsMultiKey, "", true), reason)
		changed = true
	case common.ChannelStatusManuallyDisabled:
		if model.UpdateChannelStatus(channel.Id, "", common.ChannelStatusManuallyDisabled, reason) {
			closeActiveChannelWebSockets([]int{channel.Id})
			changed = true
		}
	}
	return applied, changed, errors.Join(errs...)
}
