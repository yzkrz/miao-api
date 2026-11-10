package service

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

const (
	UserUsageWindowIdle      = "idle"
	UserUsageWindowActive    = "active"
	UserUsageWindowExhausted = "exhausted"
)

// UserUsageRuleStatus is a usage rule joined with the state of its window at
// one moment. An idle window (not started or expired) reports no usage.
type UserUsageRuleStatus struct {
	Models         []string `json:"models,omitempty"`
	Mode           string   `json:"mode,omitempty"`
	CalendarPeriod string   `json:"calendar_period,omitempty"`
	WindowSeconds  int64    `json:"window_seconds"`
	QuotaLimit     int64    `json:"quota_limit"`
	Enabled        bool     `json:"enabled"`
	Status         string   `json:"status"`
	UsedQuota      int64    `json:"used_quota"`
	WindowStart    int64    `json:"window_start"`
	ResetAt        int64    `json:"reset_at"`
}

// BuildUserUsageRuleStatuses evaluates every rule against its window state at
// now, in rule order.
func BuildUserUsageRuleStatuses(rules []model.UserUsageRule, windows []model.UserUsageWindow, now int64) []UserUsageRuleStatus {
	statuses := make([]UserUsageRuleStatus, 0, len(rules))
	for _, rule := range rules {
		status := UserUsageRuleStatus{
			Models: rule.Models, Mode: rule.Mode, CalendarPeriod: rule.CalendarPeriod,
			WindowSeconds: rule.WindowSeconds,
			QuotaLimit:    rule.QuotaLimit,
			Enabled:       rule.Enabled,
			Status:        UserUsageWindowIdle,
		}
		calendarStart, calendarEnd := rule.Bounds(now)
		if rule.Mode == "calendar" {
			status.ResetAt = calendarEnd
		}
		for i := range windows {
			active := windows[i].IsActive(now)
			if rule.Mode == "calendar" {
				active = windows[i].WindowStart == calendarStart
			}
			if windows[i].WindowSeconds != rule.WindowSeconds || !active {
				continue
			}
			status.UsedQuota = windows[i].UsedQuota
			status.WindowStart = windows[i].WindowStart
			status.ResetAt = windows[i].WindowStart + windows[i].WindowSeconds
			if rule.Mode == "calendar" {
				status.ResetAt = calendarEnd
			}
			status.Status = UserUsageWindowActive
			if status.UsedQuota >= status.QuotaLimit {
				status.Status = UserUsageWindowExhausted
			}
			break
		}
		statuses = append(statuses, status)
	}
	return statuses
}

// CheckUserUsageLimit rejects a request with 429 and Retry-After when an
// enabled usage rule of the user is exhausted in its current window. Like a
// subscription usage limit it only blocks once the window is used up, so the
// requests already in flight may settle slightly above the limit. A failure to
// read the policy or window state is logged and lets the request through: the
// limit is optional, and its storage must not become a failure point for every
// relay request, including those of users without any rule.
//
// pendingQuota is quota the caller has charged but not yet settled into the
// windows (a running realtime session); a window it would open counts as
// starting now.
func CheckUserUsageLimit(c *gin.Context, userId int, pendingQuota int64, modelNames ...string) *types.NewAPIError {
	snapshot, err := model.GetUserLimitSnapshot(userId)
	if err != nil {
		common.SysError(common.LogText("failed to load user limit policy: user %d, %s", userId, err.Error()))
		return nil
	}
	if !snapshot.HasEnabledRule() {
		return nil
	}
	windows, err := model.GetUserUsageWindows(userId)
	if err != nil {
		common.SysError(common.LogText("failed to load user usage windows: user %d, %s", userId, err.Error()))
		return nil
	}
	now := common.GetTimestamp()
	modelName := ""
	if len(modelNames) > 0 {
		modelName = modelNames[0]
	}
	// When several windows are used up, the request can only pass once the
	// one that resets last has reset, so that one is reported.
	var blocking *UserUsageRuleStatus
	for i, status := range BuildUserUsageRuleStatuses(snapshot.Rules, windows, now) {
		if !status.Enabled || !snapshot.Rules[i].AppliesTo(modelName) {
			continue
		}
		if pendingQuota > 0 {
			if status.Status == UserUsageWindowIdle {
				_, status.ResetAt = snapshot.Rules[i].Bounds(now)
			}
			status.UsedQuota += min(pendingQuota, max(status.QuotaLimit-status.UsedQuota, 0))
		}
		if status.UsedQuota < status.QuotaLimit {
			continue
		}
		if blocking == nil || status.ResetAt > blocking.ResetAt {
			blocking = &status
		}
	}
	if blocking == nil {
		return nil
	}
	c.Header("Retry-After", strconv.FormatInt(max(blocking.ResetAt-now, 1), 10))
	return types.NewErrorWithStatusCode(
		errors.New(userUsageLimitMessage(*blocking, now)),
		types.ErrorCodeUserUsageLimitReached,
		http.StatusTooManyRequests,
		types.ErrOptionWithSkipRetry(),
		types.ErrOptionWithNoRecordErrorLog(),
	)
}

func userUsageLimitMessage(status UserUsageRuleStatus, now int64) string {
	// Relay limit errors use English independently of the console language.
	const lang = i18n.LangEn
	limitKey := i18n.MsgUserUsageLimitReachedHours
	count := status.WindowSeconds / 3600
	if status.Mode == "calendar" {
		limitKey = i18n.MsgUserUsageLimitReachedCalendar
		switch status.CalendarPeriod {
		case "day":
			limitKey = i18n.MsgUserUsageLimitReachedCalendarDay
		case "week":
			limitKey = i18n.MsgUserUsageLimitReachedCalendarWeek
		case "month":
			limitKey = i18n.MsgUserUsageLimitReachedCalendarMonth
		case "quarter":
			limitKey = i18n.MsgUserUsageLimitReachedCalendarQuarter
		case "year":
			limitKey = i18n.MsgUserUsageLimitReachedCalendarYear
		}
	} else if status.WindowSeconds%86400 == 0 {
		limitKey = i18n.MsgUserUsageLimitReachedDays
		count = status.WindowSeconds / 86400
	} else if status.WindowSeconds%3600 != 0 {
		limitKey = i18n.MsgUserUsageLimitReachedMinutes
		count = status.WindowSeconds / 60
	}
	limit := i18n.Translate(lang, limitKey, map[string]any{"Count": count})

	// Round waiting times up so the displayed delay never suggests an early retry.
	seconds := max(status.ResetAt-now, 1)
	var days, hours, minutes int64
	if seconds >= 86400 {
		hours = (seconds + 3599) / 3600
		days, hours = hours/24, hours%24
	} else {
		minutes = (seconds + 59) / 60
		hours, minutes = minutes/60, minutes%60
	}
	var parts []string
	for _, part := range []struct {
		count int64
		unit  string
	}{{days, "day"}, {hours, "hour"}, {minutes, "minute"}} {
		if part.count == 0 {
			continue
		}
		unit := part.unit
		if part.count != 1 {
			unit += "s"
		}
		parts = append(parts, fmt.Sprintf("%d %s", part.count, unit))
	}
	// Convert after rounding: a DST transition can change the reset time's offset.
	resetTime := time.Unix(status.ResetAt, 0).Add(59 * time.Second).Truncate(time.Minute).
		In(time.Local).Format("2006-01-02 15:04 UTC-07:00")
	return i18n.Translate(lang, i18n.MsgUserUsageLimitResetDetails, map[string]any{
		"Limit": limit, "Duration": strings.Join(parts, " "), "ResetAt": resetTime,
	})
}
