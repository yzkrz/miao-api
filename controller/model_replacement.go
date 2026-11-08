package controller

import (
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const (
	modelReplacementSettingsBodyLimit = 1 << 20
	// maxModelReplacementHistory bounds one history response; seven days of
	// ten-minute runs over a few dozen channels stays well below it.
	maxModelReplacementHistory = 20000
)

// modelReplacementChannel is the channel information the detection pages
// need; it never carries credentials.
type modelReplacementChannel struct {
	ID     int      `json:"id"`
	Name   string   `json:"name"`
	Type   int      `json:"type"`
	Status int      `json:"status"`
	Groups []string `json:"groups"`
}

func newModelReplacementChannel(channel *model.Channel) modelReplacementChannel {
	groups := make([]string, 0)
	for _, group := range channel.GetGroups() {
		if group != "" && !slices.Contains(groups, group) {
			groups = append(groups, group)
		}
	}
	return modelReplacementChannel{
		ID:     channel.Id,
		Name:   channel.Name,
		Type:   channel.Type,
		Status: channel.Status,
		Groups: groups,
	}
}

// GetModelReplacementSettings returns the settings and the server time zone
// that interval windows are evaluated in.
func GetModelReplacementSettings(c *gin.Context) {
	common.ApiSuccess(c, gin.H{
		"settings":         operation_setting.GetModelReplacementSetting(),
		"server_time_zone": operation_setting.ServerTimeZone(),
	})
}

func UpdateModelReplacementSettings(c *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, modelReplacementSettingsBodyLimit))
	if err != nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	setting, err := operation_setting.ParseModelReplacementSetting(string(body))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	value, err := common.Marshal(setting)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.UpdateOption(operation_setting.ModelReplacementSettingOptionKey, string(value)); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, setting)
}

// GetModelReplacementCandidates lists the models that can be detected and,
// for each, every channel that serves it. Models come from enabled channels
// plus the models already configured, so a configured model stays visible
// while all of its channels are disabled.
func GetModelReplacementCandidates(c *gin.Context) {
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	slices.SortFunc(channels, func(a, b *model.Channel) int { return a.Id - b.Id })

	modelChannels := make(map[string][]modelReplacementChannel)
	for _, item := range operation_setting.GetModelReplacementSetting().Models {
		modelChannels[item.Model] = []modelReplacementChannel{}
	}
	for _, channel := range channels {
		if channel.Status == common.ChannelStatusEnabled && !slices.Contains(unsupportedTestChannelTypes, channel.Type) {
			for _, name := range channel.GetModels() {
				if name = strings.TrimSpace(name); name != "" && modelChannels[name] == nil {
					modelChannels[name] = []modelReplacementChannel{}
				}
			}
		}
	}
	for _, channel := range channels {
		if slices.Contains(unsupportedTestChannelTypes, channel.Type) {
			continue
		}
		for _, name := range channel.GetModels() {
			name = strings.TrimSpace(name)
			if served, ok := modelChannels[name]; ok && !slices.ContainsFunc(served, func(item modelReplacementChannel) bool { return item.ID == channel.Id }) {
				modelChannels[name] = append(served, newModelReplacementChannel(channel))
			}
		}
	}

	type candidate struct {
		Model    string                    `json:"model"`
		Channels []modelReplacementChannel `json:"channels"`
	}
	candidates := make([]candidate, 0, len(modelChannels))
	for name, served := range modelChannels {
		candidates = append(candidates, candidate{Model: name, Channels: served})
	}
	slices.SortFunc(candidates, func(a, b candidate) int { return strings.Compare(a.Model, b.Model) })
	common.ApiSuccess(c, candidates)
}

// GetModelReplacementOverview reports the detection switch, the last finished
// run, the active run, and when the scheduler will start the next run.
func GetModelReplacementOverview(c *gin.Context) {
	setting := operation_setting.GetModelReplacementSetting()
	taskType := model.SystemTaskTypeModelReplacementDetection

	activeTask, err := model.GetActiveSystemTask(taskType)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	finishedTasks, _, err := model.ListSystemTasks(model.SystemTaskFilter{Scope: "history", Type: taskType}, 0, 1)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	latestTask, err := model.GetLatestSystemTask(taskType)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	modelNames := make([]string, 0, len(setting.Models))
	for _, item := range setting.Models {
		modelNames = append(modelNames, item.Model)
	}
	// The wait after the latest run follows the window that run finished in;
	// before the first run it follows the current time.
	now := time.Now()
	nextInterval := modelReplacementIntervalAfter(latestTask, setting, now)
	data := gin.H{
		"enabled":               setting.Enabled,
		"interval_minutes":      setting.IntervalMinutes,
		"next_interval_minutes": int(nextInterval / time.Minute),
		"rounds":                setting.Rounds,
		"models":                modelNames,
		"last_run":              nil,
		"active_run":            nil,
		"next_run_at":           nil,
	}
	if len(finishedTasks) > 0 {
		data["last_run"] = finishedTasks[0].ToResponse()
	}
	if activeTask != nil {
		data["active_run"] = activeTask.ToResponse()
	}
	if setting.Enabled && activeTask == nil {
		data["next_run_at"] = modelReplacementNextRunAt(setting, latestTask, now)
	}
	common.ApiSuccess(c, data)
}

// RunModelReplacementDetection queues a manual detection run.
func RunModelReplacementDetection(c *gin.Context) {
	if !operation_setting.GetModelReplacementSetting().Enabled {
		common.ApiErrorT(c, "Model replacement detection is turned off. Turn it on in settings first.")
		return
	}
	task, created, err := service.EnqueueSystemTask(model.SystemTaskTypeModelReplacementDetection, modelReplacementTaskPayload{Manual: true})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if !created {
		common.ApiErrorStatus(c, http.StatusConflict, common.NewMessage("A model replacement detection run is already running or queued"), gin.H{"data": task.ToResponse()})
		return
	}
	common.ApiSuccess(c, task.ToResponse())
}

// RunModelReplacementChannelDetection queues one eligible channel. The
// remaining scheduler delay is stored in the task so the global timer pauses
// during this run and resumes with the same time left afterward.
func RunModelReplacementChannelDetection(c *gin.Context) {
	setting := operation_setting.GetModelReplacementSetting()
	if !setting.Enabled {
		common.ApiErrorT(c, "Model replacement detection is turned off. Turn it on in settings first.")
		return
	}
	channelID, err := strconv.Atoi(c.Param("id"))
	if err != nil || channelID <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	channel, err := model.GetChannelById(channelID, true)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Channel does not exist"))
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if len(selectModelReplacementTargets(setting, []*model.Channel{channel}, channelID)) == 0 {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("No channels are in detection scope yet."))
		return
	}
	latestTask, err := model.GetLatestSystemTask(model.SystemTaskTypeModelReplacementDetection)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	now := time.Now()
	nextRunAt := modelReplacementNextRunAt(setting, latestTask, now)
	payload := modelReplacementTaskPayload{
		Manual:             true,
		ChannelID:          channelID,
		ResumeAfterSeconds: max(nextRunAt-now.Unix(), 0),
	}
	task, created, err := service.EnqueueSystemTask(model.SystemTaskTypeModelReplacementDetection, payload)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if !created {
		common.ApiErrorStatus(c, http.StatusConflict, common.NewMessage("A model replacement detection run is already running or queued"), gin.H{"data": task.ToResponse()})
		return
	}
	common.ApiSuccess(c, task.ToResponse())
}

// GetModelReplacementChannels returns every channel the report covers: the
// channels in detection scope and the channels detected before, each with its
// latest record. The latest verdict is what sorts a channel into the healthy
// or abnormal list, so a channel that was never detected is in neither.
func GetModelReplacementChannels(c *gin.Context) {
	setting := operation_setting.GetModelReplacementSetting()
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	records, err := model.GetLatestModelReplacementRecords()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	latest := make(map[int]*model.ModelReplacementRecord, len(records))
	for _, record := range records {
		latest[record.ChannelID] = record
	}

	type channelRow struct {
		modelReplacementChannel
		InScope bool                              `json:"in_scope"`
		Latest  *model.ModelReplacementRecordView `json:"latest"`
	}
	rows := make([]channelRow, 0)
	for _, channel := range channels {
		row := channelRow{modelReplacementChannel: newModelReplacementChannel(channel)}
		if !slices.Contains(unsupportedTestChannelTypes, channel.Type) {
			channelModels := channel.GetModels()
			for i := range channelModels {
				channelModels[i] = strings.TrimSpace(channelModels[i])
			}
			row.InScope = slices.ContainsFunc(setting.Models, func(item operation_setting.ModelReplacementModelSetting) bool {
				return slices.Contains(channelModels, item.Model) && !slices.Contains(item.ExcludedChannelIDs, channel.Id)
			})
		}
		if record, ok := latest[channel.Id]; ok {
			view := record.View()
			row.Latest = &view
		}
		if row.InScope || row.Latest != nil {
			rows = append(rows, row)
		}
	}
	slices.SortFunc(rows, func(a, b channelRow) int { return a.ID - b.ID })
	common.ApiSuccess(c, rows)
}

// GetModelReplacementHistory returns the records created between start and
// end (Unix seconds) for the chart, for one channel when channel_id is set and
// otherwise for every channel. Without a range it covers the last 24 hours.
func GetModelReplacementHistory(c *gin.Context) {
	now := common.GetTimestamp()
	channelID, _ := strconv.Atoi(c.Query("channel_id"))
	start, startErr := strconv.ParseInt(c.DefaultQuery("start", strconv.FormatInt(now-24*60*60, 10)), 10, 64)
	end, endErr := strconv.ParseInt(c.DefaultQuery("end", strconv.FormatInt(now, 10)), 10, 64)
	if startErr != nil || endErr != nil || start > end || channelID < 0 {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	records, err := model.GetModelReplacementHistory(channelID, start, end, maxModelReplacementHistory)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	views := make([]model.ModelReplacementRecordView, 0, len(records))
	for _, record := range records {
		views = append(views, record.View())
	}
	common.ApiSuccess(c, views)
}

func GetModelReplacementRecordAttempts(c *gin.Context) {
	recordID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid parameters"))
		return
	}
	record, err := model.GetModelReplacementRecord(recordID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Detection record not found"))
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	attempts, err := model.GetModelReplacementAttempts(recordID)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"record": record.View(), "attempts": attempts})
}
