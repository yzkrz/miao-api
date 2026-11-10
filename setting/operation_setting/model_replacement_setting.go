package operation_setting

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// ModelReplacementSettingOptionKey stores the whole model replacement
// detection configuration as one JSON document, so a save replaces every
// field at once and a running detection reads one consistent snapshot.
const ModelReplacementSettingOptionKey = "ModelReplacementDetectionSetting"

const (
	ModelReplacementMatchExact    = "exact"
	ModelReplacementMatchContains = "contains"
	ModelReplacementMatchRegex    = "regex"

	DefaultModelReplacementIntervalMinutes = 10
	DefaultModelReplacementRounds          = 3
	DefaultModelReplacementConcurrency     = 3
	DefaultModelReplacementTimeoutSeconds  = 60
	DefaultModelReplacementRetryTimes      = 2

	MaxModelReplacementIntervalMinutes = 7 * 24 * 60
	MaxModelReplacementRounds          = 50
	MaxModelReplacementTimeoutSeconds  = 600
	MaxModelReplacementRetryTimes      = 10
	MaxModelReplacementModels          = 200
	MaxModelReplacementTextLength      = 4000
	maxModelReplacementGroupLength     = 64

	// MaxModelReplacementActions bounds each action list.
	MaxModelReplacementActions = 20
	// MaxModelReplacementIntervalWindows bounds the time-of-day overrides.
	MaxModelReplacementIntervalWindows = 24
	minutesPerDay                      = 24 * 60
	// ModelReplacementRoutingLimit bounds action amounts and the priority and
	// weight values actions produce, so repeated runs cannot overflow them.
	ModelReplacementRoutingLimit = math.MaxInt32
	maxModelReplacementTagLength = 64
)

// Action types run on a channel after a detection run, in configured order.
const (
	ModelReplacementActionAddGroup         = "add_group"
	ModelReplacementActionRemoveGroup      = "remove_group"
	ModelReplacementActionIncreasePriority = "increase_priority"
	ModelReplacementActionDecreasePriority = "decrease_priority"
	ModelReplacementActionSetPriority      = "set_priority"
	ModelReplacementActionIncreaseWeight   = "increase_weight"
	ModelReplacementActionDecreaseWeight   = "decrease_weight"
	ModelReplacementActionSetWeight        = "set_weight"
	ModelReplacementActionAutoDisable      = "auto_disable"
	ModelReplacementActionManualDisable    = "manual_disable"
	ModelReplacementActionSetTag           = "set_tag"
	ModelReplacementActionRemoveTag        = "remove_tag"
)

// ModelReplacementAction is one configured step. Value carries the group or
// tag; Amount carries the priority or weight number.
type ModelReplacementAction struct {
	Type   string `json:"type"`
	Value  string `json:"value"`
	Amount int64  `json:"amount"`
}

type ModelReplacementModelSetting struct {
	Model          string `json:"model"`
	Question       string `json:"question"`
	ExpectedAnswer string `json:"expected_answer"`
	MatchMode      string `json:"match_mode"`
	RetryTimes     int    `json:"retry_times"`
	// ExcludedChannelIDs lists the channels an administrator unchecked. Storing
	// exclusions instead of inclusions keeps channels added later in scope.
	ExcludedChannelIDs []int `json:"excluded_channel_ids"`
}

// ModelReplacementIntervalWindow overrides the detection interval for runs
// that finish between Start (inclusive) and End (exclusive), both HH:MM in
// the server's local time. An End earlier than Start runs past midnight, so
// 07:00-00:00 covers 07:00 to midnight.
type ModelReplacementIntervalWindow struct {
	Start           string `json:"start"`
	End             string `json:"end"`
	IntervalMinutes int    `json:"interval_minutes"`
}

type ModelReplacementSetting struct {
	Enabled bool `json:"enabled"`
	// IntervalMinutes applies when a run finishes outside every window.
	IntervalMinutes int                              `json:"interval_minutes"`
	IntervalWindows []ModelReplacementIntervalWindow `json:"interval_windows"`
	Rounds          int                              `json:"rounds"`
	Concurrency     int                              `json:"concurrency"`
	TimeoutSeconds  int                              `json:"timeout_seconds"`
	Threshold       float64                          `json:"threshold"`
	// PassActions run on a channel whose detected models all passed;
	// FailActions run only on a channel with a suspected replacement.
	// RequestFailureActions take precedence when any request exhausts retries.
	PassActions           []ModelReplacementAction       `json:"pass_actions"`
	FailActions           []ModelReplacementAction       `json:"fail_actions"`
	RequestFailureActions []ModelReplacementAction       `json:"request_failure_actions"`
	Models                []ModelReplacementModelSetting `json:"models"`
}

var modelReplacementSetting atomic.Pointer[ModelReplacementSetting]

func init() {
	defaults := DefaultModelReplacementSetting()
	modelReplacementSetting.Store(&defaults)
}

func DefaultModelReplacementSetting() ModelReplacementSetting {
	return ModelReplacementSetting{
		IntervalMinutes:       DefaultModelReplacementIntervalMinutes,
		Rounds:                DefaultModelReplacementRounds,
		Concurrency:           DefaultModelReplacementConcurrency,
		TimeoutSeconds:        DefaultModelReplacementTimeoutSeconds,
		IntervalWindows:       []ModelReplacementIntervalWindow{},
		PassActions:           []ModelReplacementAction{},
		FailActions:           []ModelReplacementAction{},
		RequestFailureActions: []ModelReplacementAction{},
		Models:                []ModelReplacementModelSetting{},
	}
}

// GetModelReplacementSetting returns the current snapshot. Callers must treat
// the slices in it as read-only; a reload swaps in a new snapshot instead of
// mutating this one.
func GetModelReplacementSetting() ModelReplacementSetting {
	return *modelReplacementSetting.Load()
}

// ModelReplacementSettingJSON is the stored form of the current snapshot.
func ModelReplacementSettingJSON() string {
	data, err := common.Marshal(modelReplacementSetting.Load())
	if err != nil {
		return "{}"
	}
	return string(data)
}

// LoadModelReplacementSetting applies a stored value. An invalid value keeps
// the previous snapshot so a bad row cannot silently reset the configuration.
func LoadModelReplacementSetting(value string) {
	parsed, err := ParseModelReplacementSetting(value)
	if err != nil {
		common.SysError(common.LogText("failed to load model replacement detection settings: %s", err.Error()))
		return
	}
	modelReplacementSetting.Store(&parsed)
}

// ParseModelReplacementSetting decodes, normalizes, and validates a stored or
// submitted configuration. Missing top-level fields take their defaults.
func ParseModelReplacementSetting(value string) (ModelReplacementSetting, error) {
	setting := DefaultModelReplacementSetting()
	if strings.TrimSpace(value) != "" {
		if err := common.UnmarshalJsonStr(value, &setting); err != nil {
			return ModelReplacementSetting{}, common.NewMessage("Invalid model replacement detection settings")
		}
	}
	return setting, setting.normalize()
}

func (setting *ModelReplacementSetting) normalize() error {
	if setting.IntervalMinutes < 1 || setting.IntervalMinutes > MaxModelReplacementIntervalMinutes {
		return common.NewMessage("Detection interval must be between 1 and {{max}} minutes", map[string]any{"max": MaxModelReplacementIntervalMinutes})
	}
	if err := setting.normalizeIntervalWindows(); err != nil {
		return err
	}
	if setting.Rounds < 1 || setting.Rounds > MaxModelReplacementRounds {
		return common.NewMessage("Test rounds must be between 1 and {{max}}", map[string]any{"max": MaxModelReplacementRounds})
	}
	if setting.Concurrency < 1 || setting.Concurrency > MaxChannelTestConcurrency {
		return common.NewMessage("Maximum concurrency must be between 1 and {{max}}", map[string]any{"max": MaxChannelTestConcurrency})
	}
	if setting.TimeoutSeconds < 1 || setting.TimeoutSeconds > MaxModelReplacementTimeoutSeconds {
		return common.NewMessage("Timeout must be between 1 and {{max}} seconds", map[string]any{"max": MaxModelReplacementTimeoutSeconds})
	}
	if setting.Threshold < 0 || setting.Threshold > 100 {
		return common.NewMessage("Mismatch threshold must be between 0 and 100")
	}

	for _, actions := range []*[]ModelReplacementAction{&setting.PassActions, &setting.FailActions, &setting.RequestFailureActions} {
		if *actions == nil {
			*actions = []ModelReplacementAction{}
		}
		if len(*actions) > MaxModelReplacementActions {
			return common.NewMessage("At most {{max}} actions can be configured for each result", map[string]any{"max": MaxModelReplacementActions})
		}
		for i := range *actions {
			if err := (*actions)[i].normalize(); err != nil {
				return err
			}
		}
	}

	if setting.Models == nil {
		setting.Models = []ModelReplacementModelSetting{}
	}
	if len(setting.Models) > MaxModelReplacementModels {
		return common.NewMessage("At most {{max}} models can be detected", map[string]any{"max": MaxModelReplacementModels})
	}
	seen := make(map[string]struct{}, len(setting.Models))
	for i := range setting.Models {
		item := &setting.Models[i]
		item.Model = strings.TrimSpace(item.Model)
		item.Question = strings.TrimSpace(item.Question)
		item.ExpectedAnswer = strings.TrimSpace(item.ExpectedAnswer)
		if item.Model == "" {
			return common.NewMessage("Model name is required")
		}
		if _, ok := seen[item.Model]; ok {
			return common.NewMessage("Model {{model}} is configured more than once", map[string]any{"model": item.Model})
		}
		seen[item.Model] = struct{}{}
		if item.Question == "" || item.ExpectedAnswer == "" {
			return common.NewMessage("Enter the test question and expected answer for {{model}}", map[string]any{"model": item.Model})
		}
		if len(item.Question) > MaxModelReplacementTextLength || len(item.ExpectedAnswer) > MaxModelReplacementTextLength {
			return common.NewMessage("The test question and expected answer for {{model}} must not exceed {{max}} characters", map[string]any{"model": item.Model, "max": MaxModelReplacementTextLength})
		}
		switch item.MatchMode {
		case ModelReplacementMatchExact, ModelReplacementMatchContains:
		case ModelReplacementMatchRegex:
			if _, err := regexp.Compile(item.ExpectedAnswer); err != nil {
				return common.NewMessage("The expected answer for {{model}} is not a valid regular expression", map[string]any{"model": item.Model})
			}
		case "":
			item.MatchMode = ModelReplacementMatchExact
		default:
			return common.NewMessage("Unknown answer match mode for {{model}}", map[string]any{"model": item.Model})
		}
		if item.RetryTimes < 0 || item.RetryTimes > MaxModelReplacementRetryTimes {
			return common.NewMessage("Retry times for {{model}} must be between 0 and {{max}}", map[string]any{"model": item.Model, "max": MaxModelReplacementRetryTimes})
		}
		item.ExcludedChannelIDs = slices.Compact(slices.Sorted(slices.Values(item.ExcludedChannelIDs)))
		if item.ExcludedChannelIDs == nil {
			item.ExcludedChannelIDs = []int{}
		}
	}
	return nil
}

// parseClockMinutes converts an HH:MM time of day to minutes after midnight.
func parseClockMinutes(value string) (int, bool) {
	hours, minutes, ok := strings.Cut(strings.TrimSpace(value), ":")
	if !ok || len(hours) != 2 || len(minutes) != 2 {
		return 0, false
	}
	hour, hourErr := strconv.Atoi(hours)
	minute, minuteErr := strconv.Atoi(minutes)
	if hourErr != nil || minuteErr != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 0, false
	}
	return hour*60 + minute, true
}

// normalizeIntervalWindows validates the time-of-day overrides, rejects
// windows that overlap, and sorts them by start time.
func (setting *ModelReplacementSetting) normalizeIntervalWindows() error {
	if setting.IntervalWindows == nil {
		setting.IntervalWindows = []ModelReplacementIntervalWindow{}
	}
	if len(setting.IntervalWindows) > MaxModelReplacementIntervalWindows {
		return common.NewMessage("At most {{max}} time windows can be configured", map[string]any{"max": MaxModelReplacementIntervalWindows})
	}
	type segment struct{ window, start, end int }
	segments := make([]segment, 0, len(setting.IntervalWindows)*2)
	for i := range setting.IntervalWindows {
		window := &setting.IntervalWindows[i]
		window.Start = strings.TrimSpace(window.Start)
		window.End = strings.TrimSpace(window.End)
		start, startOK := parseClockMinutes(window.Start)
		end, endOK := parseClockMinutes(window.End)
		if !startOK || !endOK {
			return common.NewMessage("Time windows must use 24-hour HH:MM times")
		}
		if start == end {
			return common.NewMessage("A time window must not start and end at the same time")
		}
		if window.IntervalMinutes < 1 || window.IntervalMinutes > MaxModelReplacementIntervalMinutes {
			return common.NewMessage("Detection interval must be between 1 and {{max}} minutes", map[string]any{"max": MaxModelReplacementIntervalMinutes})
		}
		if start < end {
			segments = append(segments, segment{i, start, end})
			continue
		}
		segments = append(segments, segment{i, start, minutesPerDay})
		if end > 0 {
			segments = append(segments, segment{i, 0, end})
		}
	}
	for i, a := range segments {
		for _, b := range segments[i+1:] {
			if a.window != b.window && a.start < b.end && b.start < a.end {
				first, second := setting.IntervalWindows[a.window], setting.IntervalWindows[b.window]
				return common.NewMessage("Time windows {{first}} and {{second}} overlap", map[string]any{
					"first":  first.Start + "-" + first.End,
					"second": second.Start + "-" + second.End,
				})
			}
		}
	}
	slices.SortFunc(setting.IntervalWindows, func(a, b ModelReplacementIntervalWindow) int {
		return strings.Compare(a.Start, b.Start)
	})
	return nil
}

// IntervalAt returns the wait before the next run when a run finishes at the
// given time: the interval of the window containing its local time of day,
// or the default interval outside every window.
func (setting ModelReplacementSetting) IntervalAt(finishedAt time.Time) time.Duration {
	local := finishedAt.Local()
	minute := local.Hour()*60 + local.Minute()
	for _, window := range setting.IntervalWindows {
		start, startOK := parseClockMinutes(window.Start)
		end, endOK := parseClockMinutes(window.End)
		if !startOK || !endOK {
			continue
		}
		inside := minute >= start && minute < end
		if start > end {
			inside = minute >= start || minute < end
		}
		if inside {
			return time.Duration(window.IntervalMinutes) * time.Minute
		}
	}
	return time.Duration(setting.IntervalMinutes) * time.Minute
}

// ServerTimeZone describes the server's local time zone, in which interval
// windows are evaluated, for example "UTC+08:00 (CST)".
func ServerTimeZone() string {
	name, offset := time.Now().Zone()
	sign := "+"
	if offset < 0 {
		sign = "-"
		offset = -offset
	}
	return fmt.Sprintf("UTC%s%02d:%02d (%s)", sign, offset/3600, offset%3600/60, name)
}

// normalize trims the action parameter, clears the field the type does not
// use, and validates the one it does.
func (action *ModelReplacementAction) normalize() error {
	action.Value = strings.TrimSpace(action.Value)
	switch action.Type {
	case ModelReplacementActionAddGroup, ModelReplacementActionRemoveGroup:
		action.Amount = 0
		if action.Value == "" || strings.Contains(action.Value, ",") || len(action.Value) > maxModelReplacementGroupLength {
			return common.NewMessage("Group names cannot be empty, contain commas, or exceed 64 characters")
		}
	case ModelReplacementActionSetTag, ModelReplacementActionRemoveTag:
		action.Amount = 0
		if (action.Type == ModelReplacementActionSetTag && action.Value == "") || len(action.Value) > maxModelReplacementTagLength {
			return common.NewMessage("Tags cannot be empty or exceed 64 characters")
		}
	case ModelReplacementActionIncreasePriority, ModelReplacementActionDecreasePriority,
		ModelReplacementActionIncreaseWeight, ModelReplacementActionDecreaseWeight:
		action.Value = ""
		if action.Amount < 1 || action.Amount > ModelReplacementRoutingLimit {
			return common.NewMessage("Amounts must be between 1 and {{max}}", map[string]any{"max": ModelReplacementRoutingLimit})
		}
	case ModelReplacementActionSetPriority:
		action.Value = ""
		if action.Amount < -ModelReplacementRoutingLimit || action.Amount > ModelReplacementRoutingLimit {
			return common.NewMessage("Priority must be between {{min}} and {{max}}", map[string]any{"min": -ModelReplacementRoutingLimit, "max": ModelReplacementRoutingLimit})
		}
	case ModelReplacementActionSetWeight:
		action.Value = ""
		if action.Amount < 0 || action.Amount > ModelReplacementRoutingLimit {
			return common.NewMessage("Weight must be between 0 and {{max}}", map[string]any{"max": ModelReplacementRoutingLimit})
		}
	case ModelReplacementActionAutoDisable, ModelReplacementActionManualDisable:
		action.Value = ""
		action.Amount = 0
	default:
		return common.NewMessage("Unknown detection action")
	}
	return nil
}

// AnswerMatches reports whether a model reply satisfies the configured
// expected answer. Surrounding whitespace in the reply is ignored; exact and
// contains comparisons are case-sensitive.
func (item ModelReplacementModelSetting) AnswerMatches(answer string) bool {
	answer = strings.TrimSpace(answer)
	switch item.MatchMode {
	case ModelReplacementMatchContains:
		return strings.Contains(answer, item.ExpectedAnswer)
	case ModelReplacementMatchRegex:
		pattern, err := regexp.Compile(item.ExpectedAnswer)
		if err != nil {
			return false
		}
		return pattern.MatchString(answer)
	default:
		return answer == item.ExpectedAnswer
	}
}
