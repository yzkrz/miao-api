package controller

import (
	"errors"
	"io"
	"slices"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// userLimitsView is what the admin limits panel and the user's own wallet
// page show: the configured caps joined with the live window state.
type userLimitsView struct {
	ServerTimeZone     string                        `json:"server_time_zone"`
	MaxConcurrency     int                           `json:"max_concurrency"`
	CurrentConcurrency int                           `json:"current_concurrency"`
	UsageRules         []service.UserUsageRuleStatus `json:"usage_rules"`
	UpdatedAt          int64                         `json:"updated_at"`
}

func buildUserLimitsView(userId int, enabledOnly bool) (*userLimitsView, error) {
	snapshot, err := model.LoadUserLimitSnapshot(userId)
	if err != nil {
		return nil, err
	}
	windows, err := model.GetUserUsageWindows(userId)
	if err != nil {
		return nil, err
	}
	view := &userLimitsView{
		ServerTimeZone: operation_setting.ServerTimeZone(),
		MaxConcurrency: snapshot.MaxConcurrency,
		UsageRules:     []service.UserUsageRuleStatus{},
		UpdatedAt:      snapshot.UpdatedAt,
	}
	for _, status := range service.BuildUserUsageRuleStatuses(snapshot.Rules, windows, common.GetTimestamp()) {
		if enabledOnly && !status.Enabled {
			continue
		}
		view.UsageRules = append(view.UsageRules, status)
	}
	if snapshot.MaxConcurrency > 0 {
		inUse, err := service.GetUserConcurrencyInUse(userId)
		if err != nil {
			common.SysError(common.LogText("failed to read user concurrency: user %d, %s", userId, err.Error()))
		}
		view.CurrentConcurrency = inUse
	}
	return view, nil
}

// loadLimitTargetUser resolves the :id user and checks that the operator may
// manage it, answering the request itself when either fails.
func loadLimitTargetUser(c *gin.Context) (*model.User, bool) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return nil, false
	}
	user, err := model.GetUserById(id, false)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			common.ApiErrorT(c, "User does not exist")
			return nil, false
		}
		common.ApiError(c, err)
		return nil, false
	}
	role := c.GetInt("role")
	canManage := role >= common.RoleAdminUser && canManageTargetRole(role, user.Role)
	// Audit readers may manage limits (including their own) for any non-root
	// account. Resolve the grant on every request so revocation is immediate.
	if !canManage && role >= common.RoleAdminUser && user.Role < common.RoleRootUser {
		canManage = authz.Can(c.GetInt("id"), role, authz.AuditRead)
	}
	if !canManage {
		common.ApiErrorT(c, "No permission to access users of same or higher level")
		return nil, false
	}
	return user, true
}

func GetUserLimits(c *gin.Context) {
	user, ok := loadLimitTargetUser(c)
	if !ok {
		return
	}
	view, err := buildUserLimitsView(user.Id, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// GetSelfLimits shows a user the enabled usage limits and concurrency cap an
// administrator set for them.
func GetSelfLimits(c *gin.Context) {
	view, err := buildUserLimitsView(c.GetInt("id"), true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

type updateUserLimitsRequest struct {
	MaxConcurrency int                   `json:"max_concurrency"`
	UsageRules     []model.UserUsageRule `json:"usage_rules"`
}

// GetUserLimitModels exposes routing metadata, never channel credentials.
func GetUserLimitModels(c *gin.Context) {
	if _, ok := loadLimitTargetUser(c); !ok {
		return
	}
	channels, err := model.GetAllChannels(0, -1, false, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	type source struct {
		ID     int      `json:"id"`
		Name   string   `json:"name"`
		Type   int      `json:"type"`
		Groups []string `json:"groups"`
	}
	type candidate struct {
		Model    string   `json:"model"`
		Channels []source `json:"channels"`
	}
	byName := make(map[string][]source)
	for _, channel := range channels {
		for name := range strings.SplitSeq(channel.Models, ",") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if slices.ContainsFunc(byName[name], func(item source) bool { return item.ID == channel.Id }) {
				continue
			}
			byName[name] = append(byName[name], source{channel.Id, channel.Name, channel.Type, channel.GetGroups()})
		}
	}
	var metadata []string
	if err := model.DB.Model(&model.Model{}).Where("name_rule = ?", model.NameRuleExact).Pluck("model_name", &metadata).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	for _, name := range metadata {
		if _, exists := byName[name]; !exists {
			byName[name] = []source{}
		}
	}
	rows := make([]candidate, 0, len(byName))
	for name, sources := range byName {
		rows = append(rows, candidate{name, sources})
	}
	slices.SortFunc(rows, func(a, b candidate) int { return strings.Compare(a.Model, b.Model) })
	common.ApiSuccess(c, rows)
}

// UpdateUserLimits replaces the usage limit rules and concurrency cap of a
// user. Rules whose window is unchanged keep their current window.
func UpdateUserLimits(c *gin.Context) {
	user, ok := loadLimitTargetUser(c)
	if !ok {
		return
	}
	var req updateUserLimitsRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if req.MaxConcurrency < 0 || req.MaxConcurrency > model.MaxUserConcurrencyLimit {
		common.ApiErrorT(c, "Maximum concurrency must be between 0 and {{max}}", map[string]any{"max": model.MaxUserConcurrencyLimit})
		return
	}
	if len(req.UsageRules) > model.MaxUserUsageRules {
		common.ApiErrorT(c, "At most {{count}} usage limit rules are allowed", map[string]any{"count": model.MaxUserUsageRules})
		return
	}
	windows := make(map[int64]bool, len(req.UsageRules))
	for i := range req.UsageRules {
		rule := &req.UsageRules[i]
		if rule.Mode == "window" {
			rule.Mode = ""
		}
		if rule.Mode != "" && rule.Mode != "calendar" {
			common.ApiErrorT(c, "Invalid usage limit mode or calendar period")
			return
		}
		if rule.Mode == "calendar" {
			seconds := model.CalendarUsageWindowSeconds(rule.CalendarPeriod)
			if seconds == 0 || rule.WindowSeconds != seconds {
				common.ApiErrorT(c, "Invalid usage limit mode or calendar period")
				return
			}
		} else if rule.CalendarPeriod != "" {
			common.ApiErrorT(c, "Invalid usage limit mode or calendar period")
			return
		} else if rule.WindowSeconds < model.MinUserUsageWindowSeconds || rule.WindowSeconds > model.MaxUserUsageWindowSeconds || rule.WindowSeconds%3600 != 0 {
			common.ApiErrorT(c, "Usage limit windows must be whole hours between 1 hour and 90 days")
			return
		}
		if len(rule.Models) > 10000 {
			common.ApiErrorT(c, "Invalid model selection")
			return
		}
		for j, name := range rule.Models {
			name = strings.TrimSpace(name)
			if name == "" || len(name) > 512 {
				common.ApiErrorT(c, "Invalid model selection")
				return
			}
			rule.Models[j] = name
		}
		slices.Sort(rule.Models)
		rule.Models = slices.Compact(rule.Models)
		if rule.QuotaLimit <= 0 || rule.QuotaLimit > common.MaxWalletQuota {
			common.ApiErrorT(c, "Usage limit quota is out of range")
			return
		}
		if windows[rule.WindowSeconds] {
			common.ApiErrorT(c, "Each usage limit window can only be used once")
			return
		}
		windows[rule.WindowSeconds] = true
	}
	if req.UsageRules == nil {
		req.UsageRules = []model.UserUsageRule{}
	}

	before, err := model.LoadUserLimitSnapshot(user.Id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.SaveUserLimitPolicy(user.Id, req.MaxConcurrency, req.UsageRules); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, user.Id, "user.limits_update", map[string]any{
		"target_username":        user.Username,
		"max_concurrency_before": before.MaxConcurrency,
		"max_concurrency":        req.MaxConcurrency,
		"usage_rules_before":     before.Rules,
		"usage_rules":            req.UsageRules,
	})
	view, err := buildUserLimitsView(user.Id, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

type resetUserLimitWindowsRequest struct {
	// WindowSeconds selects one window; 0 ends every window of the user.
	WindowSeconds int64 `json:"window_seconds"`
}

// ResetUserLimitWindows ends the current usage windows of a user, so the next
// charged request opens fresh ones.
func ResetUserLimitWindows(c *gin.Context) {
	user, ok := loadLimitTargetUser(c)
	if !ok {
		return
	}
	var req resetUserLimitWindowsRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil && !errors.Is(err, io.EOF) {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if req.WindowSeconds < 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if err := model.ResetUserUsageWindows(user.Id, req.WindowSeconds); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, user.Id, "user.limits_reset", map[string]any{
		"target_username": user.Username,
		"window_seconds":  req.WindowSeconds,
	})
	view, err := buildUserLimitsView(user.Id, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}
