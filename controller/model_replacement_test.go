package controller

import (
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupModelReplacementTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	if dialect := os.Getenv("TEST_MANAGE_USER_DIALECT"); dialect != "" && dialect != "sqlite" {
		db := setupManageUserTestDB(t)
		require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.ModelReplacementRecord{}, &model.ModelReplacementAttempt{}))
		return db
	}
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previousDB, previousLogDB := model.DB, model.LOG_DB
	model.DB, model.LOG_DB = db, db
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.User{}, &model.Log{}, &model.ModelReplacementRecord{}, &model.ModelReplacementAttempt{}, &model.SystemTask{}))
	return db
}

func TestModelReplacementEndpointsRequireThePermission(t *testing.T) {
	db := setupModelReplacementTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.SystemTask{}, &model.CasbinRule{}, &model.AuthzRole{}))
	previousMaster := common.IsMasterNode
	common.IsMasterNode = true
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
	require.NoError(t, authz.Init(db))
	require.NoError(t, authz.SetUserPermissions(3, authz.PermissionsMap{authz.ResourceChannel: {authz.ActionModelReplacement: true}}))

	for _, tc := range []struct {
		name       string
		id, role   int
		wantStatus int
	}{
		{"admin without the permission", 2, common.RoleAdminUser, http.StatusForbidden},
		{"admin granted the permission", 3, common.RoleAdminUser, http.StatusOK},
		{"root", 1, common.RoleRootUser, http.StatusOK},
	} {
		for _, handler := range []gin.HandlerFunc{GetModelReplacementOverview, GetModelReplacementSettings} {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/model_replacement/overview", nil)
			c.Set("id", tc.id)
			c.Set("role", tc.role)
			middleware.RequirePermission(authz.ChannelModelReplacement)(c)
			if !c.IsAborted() {
				handler(c)
			}
			assert.Equal(t, tc.wantStatus, recorder.Code, tc.name)
		}
	}
}

func TestParseModelReplacementSetting(t *testing.T) {
	defaults, err := operation_setting.ParseModelReplacementSetting("")
	require.NoError(t, err)
	assert.Equal(t, 10, defaults.IntervalMinutes)
	assert.Equal(t, 3, defaults.Rounds)
	assert.Equal(t, 3, defaults.Concurrency)
	assert.Equal(t, 60, defaults.TimeoutSeconds)
	assert.Zero(t, defaults.Threshold)
	assert.False(t, defaults.Enabled)

	normalized, err := operation_setting.ParseModelReplacementSetting(`{"models":[{"model":" gpt-4o ","question":"who?","expected_answer":" gpt-4o ","retry_times":2,"excluded_channel_ids":[5,2,5]}]}`)
	require.NoError(t, err)
	require.Len(t, normalized.Models, 1)
	assert.Equal(t, "gpt-4o", normalized.Models[0].Model)
	assert.Equal(t, "gpt-4o", normalized.Models[0].ExpectedAnswer)
	assert.Equal(t, operation_setting.ModelReplacementMatchExact, normalized.Models[0].MatchMode)
	assert.Equal(t, []int{2, 5}, normalized.Models[0].ExcludedChannelIDs)

	actions, err := operation_setting.ParseModelReplacementSetting(`{"enabled":true,"pass_actions":[{"type":"add_group","value":" healthy ","amount":3},{"type":"remove_tag"},{"type":"set_priority","value":"x","amount":-5}],"fail_actions":[{"type":"auto_disable","value":"x","amount":1}]}`)
	require.NoError(t, err)
	assert.Equal(t, []operation_setting.ModelReplacementAction{
		{Type: operation_setting.ModelReplacementActionAddGroup, Value: "healthy"},
		{Type: operation_setting.ModelReplacementActionRemoveTag},
		{Type: operation_setting.ModelReplacementActionSetPriority, Amount: -5},
	}, actions.PassActions)
	assert.Equal(t, []operation_setting.ModelReplacementAction{{Type: operation_setting.ModelReplacementActionAutoDisable}}, actions.FailActions)

	for name, value := range map[string]string{
		"unknown action":         `{"pass_actions":[{"type":"delete_channel"}]}`,
		"empty group":            `{"pass_actions":[{"type":"add_group","value":" "}]}`,
		"group with comma":       `{"fail_actions":[{"type":"remove_group","value":"a,b"}]}`,
		"empty tag":              `{"fail_actions":[{"type":"set_tag"}]}`,
		"zero increase":          `{"pass_actions":[{"type":"increase_priority","amount":0}]}`,
		"negative weight":        `{"pass_actions":[{"type":"set_weight","amount":-1}]}`,
		"invalid regex":          `{"models":[{"model":"m","question":"q","expected_answer":"(","match_mode":"regex"}]}`,
		"duplicate model":        `{"models":[{"model":"m","question":"q","expected_answer":"a"},{"model":"m","question":"q","expected_answer":"a"}]}`,
		"missing answer":         `{"models":[{"model":"m","question":"q","expected_answer":""}]}`,
		"retry out of range":     `{"models":[{"model":"m","question":"q","expected_answer":"a","retry_times":11}]}`,
		"threshold out of range": `{"threshold":101}`,
		"zero rounds":            `{"rounds":0}`,
	} {
		_, err := operation_setting.ParseModelReplacementSetting(value)
		assert.Error(t, err, name)
	}
}

func TestModelReplacementIntervalWindows(t *testing.T) {
	setting, err := operation_setting.ParseModelReplacementSetting(`{"interval_minutes":10,"interval_windows":[{"start":"07:00","end":"00:00","interval_minutes":30},{"start":"00:00","end":"07:00","interval_minutes":60}]}`)
	require.NoError(t, err)
	assert.Equal(t, []string{"00:00", "07:00"}, []string{setting.IntervalWindows[0].Start, setting.IntervalWindows[1].Start}, "windows are kept in start order")

	at := func(hour, minute int) time.Time { return time.Date(2026, 11, 6, hour, minute, 0, 0, time.Local) }
	for _, tc := range []struct {
		hour, minute int
		want         time.Duration
	}{
		{0, 0, time.Hour},
		{3, 30, time.Hour},
		{6, 59, time.Hour},
		{7, 0, 30 * time.Minute},
		{23, 59, 30 * time.Minute},
	} {
		assert.Equal(t, tc.want, setting.IntervalAt(at(tc.hour, tc.minute)), "%02d:%02d", tc.hour, tc.minute)
	}

	night, err := operation_setting.ParseModelReplacementSetting(`{"interval_minutes":10,"interval_windows":[{"start":"22:00","end":"02:00","interval_minutes":90}]}`)
	require.NoError(t, err)
	assert.Equal(t, 90*time.Minute, night.IntervalAt(at(23, 0)), "a window ending earlier than it starts runs past midnight")
	assert.Equal(t, 90*time.Minute, night.IntervalAt(at(1, 59)))
	assert.Equal(t, 10*time.Minute, night.IntervalAt(at(2, 0)), "the end time is outside the window")
	assert.Equal(t, 10*time.Minute, night.IntervalAt(at(12, 0)), "outside every window the default applies")

	for name, value := range map[string]string{
		"overlap":                 `{"interval_windows":[{"start":"00:00","end":"08:00","interval_minutes":60},{"start":"07:00","end":"12:00","interval_minutes":30}]}`,
		"overlap across midnight": `{"interval_windows":[{"start":"22:00","end":"02:00","interval_minutes":60},{"start":"01:00","end":"03:00","interval_minutes":30}]}`,
		"same start and end":      `{"interval_windows":[{"start":"08:00","end":"08:00","interval_minutes":60}]}`,
		"bad time":                `{"interval_windows":[{"start":"24:00","end":"07:00","interval_minutes":60}]}`,
		"interval out of range":   `{"interval_windows":[{"start":"00:00","end":"07:00","interval_minutes":0}]}`,
	} {
		_, err := operation_setting.ParseModelReplacementSetting(value)
		assert.Error(t, err, name)
	}
	_, err = operation_setting.ParseModelReplacementSetting(`{"interval_windows":[{"start":"00:00","end":"07:00","interval_minutes":60},{"start":"07:00","end":"00:00","interval_minutes":30}]}`)
	assert.NoError(t, err, "adjacent windows do not overlap")
}

func TestModelReplacementAnswerMatches(t *testing.T) {
	for _, tc := range []struct {
		mode, expected, answer string
		matched                bool
	}{
		{operation_setting.ModelReplacementMatchExact, "Claude", " Claude\n", true},
		{operation_setting.ModelReplacementMatchExact, "Claude", "claude", false},
		{operation_setting.ModelReplacementMatchContains, "Claude", "I am Claude, by Anthropic", true},
		{operation_setting.ModelReplacementMatchContains, "Claude", "I am GPT", false},
		{operation_setting.ModelReplacementMatchRegex, `(?i)^claude`, "CLAUDE 3", true},
		{operation_setting.ModelReplacementMatchRegex, `^\d+$`, "42 apples", false},
	} {
		item := operation_setting.ModelReplacementModelSetting{MatchMode: tc.mode, ExpectedAnswer: tc.expected}
		assert.Equal(t, tc.matched, item.AnswerMatches(tc.answer), "%s %q %q", tc.mode, tc.expected, tc.answer)
	}
}

func TestSelectModelReplacementTargetsSkipsDisabledAndExcludedChannels(t *testing.T) {
	setting := operation_setting.ModelReplacementSetting{Models: []operation_setting.ModelReplacementModelSetting{
		{Model: "a", ExcludedChannelIDs: []int{3}},
		{Model: "b"},
	}}
	channels := []*model.Channel{
		{Id: 9, Status: common.ChannelStatusEnabled, Models: "a"},
		{Id: 1, Status: common.ChannelStatusEnabled, Models: "a, b"},
		{Id: 2, Status: common.ChannelStatusAutoDisabled, Models: "a"},
		{Id: 4, Status: common.ChannelStatusManuallyDisabled, Models: "b"},
		{Id: 3, Status: common.ChannelStatusEnabled, Models: "a,b"},
		{Id: 5, Status: common.ChannelStatusEnabled, Models: "c"},
		{Id: 6, Status: common.ChannelStatusEnabled, Models: "a", Type: constant.ChannelTypeMidjourney},
	}

	targets := selectModelReplacementTargets(setting, channels, 0)

	got := map[int][]string{}
	for _, target := range targets {
		for _, item := range target.models {
			got[target.channel.Id] = append(got[target.channel.Id], item.Model)
		}
	}
	assert.Equal(t, map[int][]string{1: {"a", "b"}, 3: {"b"}, 9: {"a"}}, got)
	require.Len(t, targets, 3)
	assert.Equal(t, 1, targets[0].channel.Id)

	singleTarget := selectModelReplacementTargets(setting, channels, 1)
	require.Len(t, singleTarget, 1)
	assert.Equal(t, 1, singleTarget[0].channel.Id)
	assert.Empty(t, selectModelReplacementTargets(setting, channels, 5))
}

func TestModelReplacementNextRunResumesThePausedChannelTimer(t *testing.T) {
	setting := operation_setting.ModelReplacementSetting{IntervalMinutes: 10}
	task := &model.SystemTask{
		UpdatedAt: 100,
		Payload:   "{\"manual\":true,\"channel_id\":7,\"resume_after_seconds\":120}",
	}

	assert.EqualValues(t, 220, modelReplacementNextRunAt(setting, task, time.Unix(200, 0)))
	assert.Equal(t, 120*time.Second, modelReplacementIntervalAfter(task, setting, time.Unix(100, 0)))

	task.Payload = "{\"manual\":true}"
	assert.Equal(t, 600*time.Second, modelReplacementIntervalAfter(task, setting, time.Unix(100, 0)))
}

func TestRunModelReplacementChannelDetectionQueuesOnlyAnEligibleChannel(t *testing.T) {
	db := setupModelReplacementTestDB(t)
	previousSetting := operation_setting.ModelReplacementSettingJSON()
	t.Cleanup(func() { operation_setting.LoadModelReplacementSetting(previousSetting) })
	operation_setting.LoadModelReplacementSetting("{\"enabled\":true,\"interval_minutes\":10,\"rounds\":1,\"models\":[{\"model\":\"gpt-4o\",\"question\":\"Who are you?\",\"expected_answer\":\"gpt-4o\"}]}")

	channel := &model.Channel{Id: 21, Name: "single", Key: "sk-test", Status: common.ChannelStatusEnabled, Models: "gpt-4o", Group: "default"}
	require.NoError(t, channel.Insert())
	disabled := &model.Channel{Id: 22, Name: "disabled", Key: "sk-test", Status: common.ChannelStatusManuallyDisabled, Models: "gpt-4o", Group: "default"}
	require.NoError(t, disabled.Insert())
	now := common.GetTimestamp()
	require.NoError(t, db.Create(&model.SystemTask{TaskID: "previous-detection", Type: model.SystemTaskTypeModelReplacementDetection, Status: model.SystemTaskStatusSucceeded, UpdatedAt: now - 120}).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/model_replacement/channels/21/run", nil)
	c.Params = gin.Params{{Key: "id", Value: "21"}}
	RunModelReplacementChannelDetection(c)

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			TaskID  string                      `json:"task_id"`
			Payload modelReplacementTaskPayload `json:"payload"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	assert.NotEmpty(t, response.Data.TaskID)
	assert.Equal(t, 21, response.Data.Payload.ChannelID)
	assert.True(t, response.Data.Payload.Manual)
	assert.InDelta(t, 480, response.Data.Payload.ResumeAfterSeconds, 2)

	active, err := model.GetActiveSystemTask(model.SystemTaskTypeModelReplacementDetection)
	require.NoError(t, err)
	require.NotNil(t, active)
	require.Equal(t, response.Data.TaskID, active.TaskID)

	recorder = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/model_replacement/channels/22/run", nil)
	c.Params = gin.Params{{Key: "id", Value: "22"}}
	RunModelReplacementChannelDetection(c)
	assert.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestSummarizeModelReplacementAttempts(t *testing.T) {
	models := []operation_setting.ModelReplacementModelSetting{{Model: "a"}, {Model: "b"}}
	oneMismatch := []model.ModelReplacementAttempt{
		{Model: "a", Success: true, Matched: true},
		{Model: "b", Success: true, Matched: true},
		{Model: "a", Success: true, Matched: false},
		{Model: "b", Success: true, Matched: true},
		{Model: "a", Success: true, Matched: true},
		{Model: "b", Success: true, Matched: true},
	}

	stats, verdict, matchPercent := summarizeModelReplacementAttempts(models, oneMismatch, 0)
	assert.Equal(t, model.ModelReplacementVerdictReplaced, verdict)
	assert.InDelta(t, 200.0/3, matchPercent, 0.001)
	require.Len(t, stats, 2)
	assert.Equal(t, model.ModelReplacementVerdictReplaced, stats[0].Verdict)
	assert.Equal(t, 1, stats[0].Mismatched)
	assert.Equal(t, model.ModelReplacementVerdictPassed, stats[1].Verdict)

	_, verdict, _ = summarizeModelReplacementAttempts(models, oneMismatch, 34)
	assert.Equal(t, model.ModelReplacementVerdictPassed, verdict)

	failed := []model.ModelReplacementAttempt{{Model: "a", Success: true, Matched: false}, {Model: "b", Success: false}}
	stats, verdict, _ = summarizeModelReplacementAttempts(models, failed, 0)
	assert.Equal(t, model.ModelReplacementVerdictFailed, verdict)
	assert.Equal(t, model.ModelReplacementVerdictFailed, stats[1].Verdict)
}

func TestExtractModelReplacementAnswer(t *testing.T) {
	for name, tc := range map[string]struct {
		body     string
		isStream bool
		answer   string
	}{
		"chat completion": {body: `{"choices":[{"message":{"content":" gpt-4o \n"}}]}`, answer: "gpt-4o"},
		"chat parts":      {body: `{"choices":[{"message":{"content":[{"type":"text","text":"gpt"},{"type":"text","text":"-4o"}]}}]}`, answer: "gpt-4o"},
		"responses":       {body: `{"output":[{"type":"reasoning"},{"type":"message","content":[{"type":"output_text","text":"codex"}]}]}`, answer: "codex"},
		"responses stream": {
			body:     "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"co\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"dex\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n",
			isStream: true,
			answer:   "codex",
		},
		"responses completed only": {
			body:     "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"content\":[{\"type\":\"output_text\",\"text\":\"codex\"}]}]}}\n",
			isStream: true,
			answer:   "codex",
		},
		"chat stream": {
			body:     "data: {\"choices\":[{\"delta\":{\"content\":\"gpt\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"-4o\"}}]}\n\ndata: [DONE]\n",
			isStream: true,
			answer:   "gpt-4o",
		},
	} {
		answer, err := extractModelReplacementAnswer([]byte(tc.body), tc.isStream)
		require.NoError(t, err, name)
		assert.Equal(t, tc.answer, answer, name)
	}

	_, err := extractModelReplacementAnswer([]byte(`{"choices":[{"message":{"content":"  "}}]}`), false)
	assert.Error(t, err)
}

func TestRewriteChannelGroupsOnlyTouchesDetectionGroups(t *testing.T) {
	for _, tc := range []struct {
		group, add string
		remove     []string
		want       string
	}{
		{"default, vip ,abnormal", "healthy", []string{"abnormal"}, "default, vip ,healthy"},
		{"vip,healthy,default", "healthy", []string{"abnormal"}, "vip,healthy,default"},
		{"healthy,vip", "abnormal", []string{"healthy"}, "vip,abnormal"},
		{"vip,healthy,default,abnormal", "", []string{"healthy", "abnormal"}, "vip,default"},
		{"", "healthy", []string{"abnormal"}, "healthy"},
		{"healthy", "", []string{"healthy", "abnormal"}, ""},
	} {
		assert.Equal(t, tc.want, rewriteChannelGroups(tc.group, tc.add, tc.remove...), "%q add %q remove %v", tc.group, tc.add, tc.remove)
	}
}

func TestApplyModelReplacementActions(t *testing.T) {
	db := setupModelReplacementTestDB(t)
	priority, weight, tag := int64(10), uint(5), "old"
	channel := &model.Channel{Id: 7, Name: "upstream", Key: "sk-test", Status: common.ChannelStatusEnabled, Models: "gpt-4o", Group: "vip, default,abnormal", Priority: &priority, Weight: &weight, Tag: &tag}
	require.NoError(t, channel.Insert())
	reload := func(id int) *model.Channel {
		loaded, err := model.GetChannelById(id, true)
		require.NoError(t, err)
		return loaded
	}
	abilities := func(id int) []model.Ability {
		var rows []model.Ability
		require.NoError(t, db.Where("channel_id = ?", id).Find(&rows).Error)
		slices.SortFunc(rows, func(a, b model.Ability) int { return strings.Compare(a.Group, b.Group) })
		return rows
	}
	action := func(actionType string, value string, amount int64) operation_setting.ModelReplacementAction {
		return operation_setting.ModelReplacementAction{Type: actionType, Value: value, Amount: amount}
	}
	// A per-group ability edit outside the named groups survives group actions.
	require.NoError(t, db.Model(&model.Ability{}).Where(map[string]any{"channel_id": channel.Id, "group": "vip"}).Update("priority", 42).Error)

	applied, changed, err := applyModelReplacementActions(reload(channel.Id), model.ModelReplacementVerdictPassed, []operation_setting.ModelReplacementAction{
		action(operation_setting.ModelReplacementActionRemoveGroup, "abnormal", 0),
		action(operation_setting.ModelReplacementActionAddGroup, "healthy", 0),
		action(operation_setting.ModelReplacementActionAddGroup, "healthy", 0),
	})
	require.NoError(t, err)
	assert.True(t, changed)
	assert.Equal(t, []bool{true, true, false}, []bool{applied[0].Changed, applied[1].Changed, applied[2].Changed})
	assert.Equal(t, "vip, default,healthy", reload(channel.Id).Group)
	rows := abilities(channel.Id)
	require.Len(t, rows, 3)
	assert.Equal(t, []string{" default", "healthy", "vip"}, []string{rows[0].Group, rows[1].Group, rows[2].Group})
	assert.EqualValues(t, 42, *rows[2].Priority, "the vip ability is not rebuilt")

	_, _, err = applyModelReplacementActions(reload(channel.Id), model.ModelReplacementVerdictReplaced, []operation_setting.ModelReplacementAction{
		action(operation_setting.ModelReplacementActionSetPriority, "", 100),
		action(operation_setting.ModelReplacementActionIncreasePriority, "", 1),
		action(operation_setting.ModelReplacementActionDecreaseWeight, "", 10),
		action(operation_setting.ModelReplacementActionRemoveTag, "other", 0),
	})
	require.NoError(t, err)
	updated := reload(channel.Id)
	assert.EqualValues(t, 101, updated.GetPriority(), "actions run in order")
	assert.Equal(t, 0, updated.GetWeight(), "weight never goes below zero")
	assert.Equal(t, "old", updated.GetTag(), "a different tag is not removed")
	for _, row := range abilities(channel.Id) {
		assert.EqualValues(t, 101, *row.Priority)
		assert.Zero(t, row.Weight)
		require.NotNil(t, row.Tag)
		assert.Equal(t, "old", *row.Tag)
	}

	_, _, err = applyModelReplacementActions(reload(channel.Id), model.ModelReplacementVerdictReplaced, []operation_setting.ModelReplacementAction{
		action(operation_setting.ModelReplacementActionRemoveTag, "", 0),
		action(operation_setting.ModelReplacementActionDecreasePriority, "", 200),
		action(operation_setting.ModelReplacementActionDecreasePriority, "", 1),
		action(operation_setting.ModelReplacementActionSetWeight, "", 3),
		action(operation_setting.ModelReplacementActionIncreaseWeight, "", operation_setting.ModelReplacementRoutingLimit),
		action(operation_setting.ModelReplacementActionManualDisable, "", 0),
	})
	require.NoError(t, err)
	updated = reload(channel.Id)
	assert.Zero(t, updated.GetPriority(), "repeated priority decreases stop at zero")
	assert.Empty(t, updated.GetTag())
	assert.Equal(t, operation_setting.ModelReplacementRoutingLimit, updated.GetWeight(), "weight is capped")
	assert.Equal(t, common.ChannelStatusManuallyDisabled, updated.Status)
	assert.Equal(t, "Model replacement detection found a replaced model", updated.GetOtherInfo()["status_reason"])
	for _, row := range abilities(channel.Id) {
		assert.Nil(t, row.Tag)
		assert.Zero(t, *row.Priority, "routing abilities inherit the priority floor")
		assert.False(t, row.Enabled)
	}

	failing := &model.Channel{Id: 9, Name: "failing", Key: "sk-test", Status: common.ChannelStatusEnabled, Models: "gpt-4o", Group: "default,healthy"}
	require.NoError(t, failing.Insert())
	applied, _, err = applyModelReplacementActions(reload(failing.Id), model.ModelReplacementVerdictFailed, []operation_setting.ModelReplacementAction{
		action(operation_setting.ModelReplacementActionRemoveGroup, "healthy", 0),
		action(operation_setting.ModelReplacementActionSetTag, "suspect", 0),
		action(operation_setting.ModelReplacementActionAutoDisable, "", 0),
	})
	require.NoError(t, err)
	require.Len(t, applied, 3)
	failed := reload(failing.Id)
	assert.Equal(t, "default", failed.Group)
	assert.Equal(t, "suspect", failed.GetTag())
	assert.Equal(t, common.ChannelStatusAutoDisabled, failed.Status)
	assert.Equal(t, "Model replacement detection requests failed after all retries", failed.GetOtherInfo()["status_reason"])

	paused := &model.Channel{Id: 8, Name: "paused", Key: "sk-test", Status: common.ChannelStatusEnabled, Models: "gpt-4o", Group: "default,healthy"}
	require.NoError(t, paused.Insert())
	require.True(t, model.UpdateChannelStatus(paused.Id, "", common.ChannelStatusManuallyDisabled, "maintenance"))
	applied, changed, err = applyModelReplacementActions(paused, model.ModelReplacementVerdictFailed, []operation_setting.ModelReplacementAction{
		action(operation_setting.ModelReplacementActionRemoveGroup, "healthy", 0),
		action(operation_setting.ModelReplacementActionAutoDisable, "", 0),
	})
	require.NoError(t, err)
	assert.Empty(t, applied)
	assert.False(t, changed)
	assert.Equal(t, "default,healthy", reload(paused.Id).Group)
	assert.Equal(t, common.ChannelStatusManuallyDisabled, reload(paused.Id).Status, "a channel disabled by an administrator during the run is left alone")
}

func TestModelReplacementRecordsLeaveOutDeletedChannelsAndPurge(t *testing.T) {
	db := setupModelReplacementTestDB(t)
	require.NoError(t, db.Create(&[]model.Channel{{Id: 1, Name: "one"}, {Id: 2, Name: "two"}, {Id: 3, Name: "deleted"}}).Error)
	create := func(channelID int, createdAt int64) {
		record := &model.ModelReplacementRecord{ChannelID: channelID, Verdict: model.ModelReplacementVerdictPassed, CreatedAt: createdAt}
		require.NoError(t, model.CreateModelReplacementRecord(record, []model.ModelReplacementAttempt{{Model: "m", Round: 1}, {Model: "m", Round: 2}}))
	}
	create(1, 100)
	create(2, 100)
	create(3, 300)
	create(1, 200)
	require.NoError(t, db.Delete(&model.Channel{Id: 3}).Error)

	latest, err := model.GetLatestModelReplacementRecords()
	require.NoError(t, err)
	latestByChannel := map[int]int64{}
	for _, record := range latest {
		latestByChannel[record.ChannelID] = record.CreatedAt
	}
	assert.Equal(t, map[int]int64{1: 200, 2: 100, 3: 300}, latestByChannel)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/model_replacement/channels", nil)
	GetModelReplacementChannels(c)
	var listed struct {
		Data []struct {
			ID int `json:"id"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &listed))
	listedIDs := make([]int, 0, len(listed.Data))
	for _, row := range listed.Data {
		listedIDs = append(listedIDs, row.ID)
	}
	assert.Equal(t, []int{1, 2}, listedIDs, "a deleted channel is not listed")

	all, err := model.GetModelReplacementHistory(0, 0, math.MaxInt64, 10)
	require.NoError(t, err)
	allChannels := make([]int, 0, len(all))
	for _, record := range all {
		allChannels = append(allChannels, record.ChannelID)
	}
	assert.Equal(t, []int{1, 2, 1}, allChannels, "every remaining channel, oldest first, without the deleted one")
	inRange, err := model.GetModelReplacementHistory(1, 50, 150, 10)
	require.NoError(t, err)
	require.Len(t, inRange, 1)
	assert.EqualValues(t, 100, inRange[0].CreatedAt)
	deleted, err := model.GetModelReplacementHistory(3, 0, math.MaxInt64, 10)
	require.NoError(t, err)
	assert.Empty(t, deleted)

	require.NoError(t, model.PurgeModelReplacementRecords(150))
	var remaining []model.ModelReplacementRecord
	require.NoError(t, db.Find(&remaining).Error)
	require.Len(t, remaining, 1, "expired records and the deleted channel's newer record are purged")
	assert.Equal(t, 1, remaining[0].ChannelID)
	assert.EqualValues(t, 200, remaining[0].CreatedAt)
	var remainingAttempts []model.ModelReplacementAttempt
	require.NoError(t, db.Find(&remainingAttempts).Error)
	require.Len(t, remainingAttempts, 2)
	assert.Equal(t, remaining[0].ID, remainingAttempts[0].RecordID)
}

func TestModelReplacementDetectionProbesChannelsAndAppliesVerdicts(t *testing.T) {
	db := setupModelReplacementTestDB(t)
	previousRedis := common.RedisEnabled
	common.RedisEnabled = false
	previousModelRatios := ratio_setting.ModelRatio2JSONString()
	t.Cleanup(func() {
		common.RedisEnabled = previousRedis
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(previousModelRatios))
	})
	require.NoError(t, i18n.Init())
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"mr-probe-model":1}`))
	service.InitHttpClient()
	require.NoError(t, db.Create(&model.User{Id: 1, Username: "root", Role: common.RoleRootUser, Status: common.UserStatusEnabled, Group: "default"}).Error)

	const question = "Which model are you? Reply with the model name only."
	var honestBodies atomic.Value
	upstream := func(answer string, calls *atomic.Int32) *httptest.Server {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			body, _ := io.ReadAll(r.Body)
			if answer == "" {
				http.Error(w, `{"error":{"message":"upstream exploded"}}`, http.StatusInternalServerError)
				return
			}
			honestBodies.Store(string(body))
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"id":"chatcmpl-1","object":"chat.completion","model":"mr-probe-model","choices":[{"index":0,"message":{"role":"assistant","content":"`+answer+`"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}`)
		}))
		t.Cleanup(server.Close)
		return server
	}
	var honestCalls, swappedCalls, brokenCalls, disabledCalls atomic.Int32
	honest := upstream("I am mr-probe-model", &honestCalls)
	swapped := upstream("I am claude-3", &swappedCalls)
	broken := upstream("", &brokenCalls)
	disabled := upstream("I am mr-probe-model", &disabledCalls)

	insert := func(id int, baseURL string, group string, status int) {
		channel := &model.Channel{Id: id, Name: "channel", Key: "sk-test", Type: constant.ChannelTypeOpenAI, Status: status, Models: "mr-probe-model", Group: group, BaseURL: &baseURL}
		require.NoError(t, channel.Insert())
	}
	insert(1, honest.URL, "default,abnormal", common.ChannelStatusEnabled)
	insert(2, swapped.URL, "default,healthy", common.ChannelStatusEnabled)
	insert(3, broken.URL, "default,healthy", common.ChannelStatusEnabled)
	insert(4, disabled.URL, "default,abnormal", common.ChannelStatusAutoDisabled)

	previous := operation_setting.ModelReplacementSettingJSON()
	t.Cleanup(func() { operation_setting.LoadModelReplacementSetting(previous) })
	operation_setting.LoadModelReplacementSetting(`{"enabled":true,"rounds":2,"concurrency":2,"timeout_seconds":10,"threshold":0,"pass_actions":[{"type":"remove_group","value":"abnormal"},{"type":"add_group","value":"healthy"}],"fail_actions":[{"type":"remove_group","value":"healthy"},{"type":"add_group","value":"abnormal"},{"type":"decrease_priority","amount":10}],"models":[{"model":"mr-probe-model","question":"` + question + `","expected_answer":"mr-probe-model","match_mode":"contains","retry_times":1}]}`)
	require.True(t, operation_setting.GetModelReplacementSetting().Enabled)

	var lastProcessed, lastTotal int
	summary, err := runModelReplacementDetection(context.Background(), "run-1", true, 0, func(processed, total int) {
		lastProcessed, lastTotal = processed, total
	})
	require.NoError(t, err)

	assert.Equal(t, modelReplacementRunSummary{StartedAt: summary.StartedAt, FinishedAt: summary.FinishedAt, Manual: true, Channels: 3, Passed: 1, Replaced: 1, Failed: 1}, summary)
	assert.Equal(t, 6, lastTotal)
	assert.Equal(t, 6, lastProcessed)
	assert.EqualValues(t, 2, honestCalls.Load(), "one request per round")
	assert.EqualValues(t, 2, brokenCalls.Load(), "the first request and its retry, then the channel is skipped")
	assert.Zero(t, disabledCalls.Load(), "disabled channels are skipped")
	assert.Contains(t, honestBodies.Load(), question)

	channels := map[int]*model.Channel{}
	for id := 1; id <= 4; id++ {
		channel, err := model.GetChannelById(id, true)
		require.NoError(t, err)
		channels[id] = channel
	}
	assert.Equal(t, "default,healthy", channels[1].Group)
	assert.Zero(t, channels[1].GetPriority())
	for _, id := range []int{2, 3} {
		assert.Equal(t, "default,abnormal", channels[id].Group, "fail actions run for replaced and failed channels")
		assert.Zero(t, channels[id].GetPriority(), "failure actions cannot lower priority below zero")
		assert.Equal(t, common.ChannelStatusEnabled, channels[id].Status, "no configured action disables the channel")
	}
	assert.Equal(t, "default,abnormal", channels[4].Group)

	history, err := model.GetModelReplacementHistory(1, 0, math.MaxInt64, 10)
	require.NoError(t, err)
	require.Len(t, history, 1)
	assert.Equal(t, model.ModelReplacementVerdictPassed, history[0].Verdict)
	assert.Equal(t, []model.ModelReplacementAppliedAction{
		{Type: operation_setting.ModelReplacementActionRemoveGroup, Value: "abnormal", Changed: true},
		{Type: operation_setting.ModelReplacementActionAddGroup, Value: "healthy", Changed: true},
	}, history[0].View().Actions)
	assert.Equal(t, 100.0, history[0].MatchPercent)
	attempts, err := model.GetModelReplacementAttempts(history[0].ID)
	require.NoError(t, err)
	require.Len(t, attempts, 2)
	assert.Equal(t, "I am mr-probe-model", attempts[0].Answer)
	assert.True(t, attempts[0].Matched)
	assert.Equal(t, []int{1, 2}, []int{attempts[0].Round, attempts[1].Round})

	brokenHistory, err := model.GetModelReplacementHistory(3, 0, math.MaxInt64, 10)
	require.NoError(t, err)
	require.Len(t, brokenHistory, 1)
	assert.Equal(t, model.ModelReplacementVerdictFailed, brokenHistory[0].Verdict)
	brokenAttempts, err := model.GetModelReplacementAttempts(brokenHistory[0].ID)
	require.NoError(t, err)
	require.Len(t, brokenAttempts, 1)
	assert.Equal(t, 2, brokenAttempts[0].Tries)
	assert.True(t, strings.Contains(brokenAttempts[0].ErrorMessage, "upstream exploded"), brokenAttempts[0].ErrorMessage)
}
