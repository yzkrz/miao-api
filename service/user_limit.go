package service

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
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
	WindowSeconds int64  `json:"window_seconds"`
	QuotaLimit    int64  `json:"quota_limit"`
	Enabled       bool   `json:"enabled"`
	Status        string `json:"status"`
	UsedQuota     int64  `json:"used_quota"`
	WindowStart   int64  `json:"window_start"`
	ResetAt       int64  `json:"reset_at"`
}

// BuildUserUsageRuleStatuses evaluates every rule against its window state at
// now, in rule order.
func BuildUserUsageRuleStatuses(rules []model.UserUsageRule, windows []model.UserUsageWindow, now int64) []UserUsageRuleStatus {
	statuses := make([]UserUsageRuleStatus, 0, len(rules))
	for _, rule := range rules {
		status := UserUsageRuleStatus{
			WindowSeconds: rule.WindowSeconds,
			QuotaLimit:    rule.QuotaLimit,
			Enabled:       rule.Enabled,
			Status:        UserUsageWindowIdle,
		}
		for i := range windows {
			if windows[i].WindowSeconds != rule.WindowSeconds || !windows[i].IsActive(now) {
				continue
			}
			status.UsedQuota = windows[i].UsedQuota
			status.WindowStart = windows[i].WindowStart
			status.ResetAt = windows[i].WindowStart + windows[i].WindowSeconds
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
func CheckUserUsageLimit(c *gin.Context, userId int, pendingQuota int64) *types.NewAPIError {
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
	// When several windows are used up, the request can only pass once the
	// one that resets last has reset, so that one is reported.
	var blocking *UserUsageRuleStatus
	for _, status := range BuildUserUsageRuleStatuses(snapshot.Rules, windows, now) {
		if !status.Enabled {
			continue
		}
		if pendingQuota > 0 {
			if status.Status == UserUsageWindowIdle {
				status.ResetAt = now + status.WindowSeconds
			}
			status.UsedQuota += pendingQuota
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
		errors.New(userUsageLimitMessage(blocking.WindowSeconds, blocking.ResetAt, now)),
		types.ErrorCodeUserUsageLimitReached,
		http.StatusTooManyRequests,
		types.ErrOptionWithSkipRetry(),
		types.ErrOptionWithNoRecordErrorLog(),
	)
}

// userUsageLimitResetZone is the zone the usage limit message shows the reset
// time in, whatever the time zone of the server.
var userUsageLimitResetZone = time.FixedZone("UTC+8", 8*3600)

// userUsageLimitMessage names the used-up window and when it resets, as the
// time left and as a UTC+8 clock time. It is English whatever language the
// user reads. Both times round up to the minute (the time left to the hour once
// it is a day or more), so a retry at the time shown is past the reset.
func userUsageLimitMessage(windowSeconds, resetAt, now int64) string {
	window := fmt.Sprintf("%d-hour", windowSeconds/3600)
	if windowSeconds%86400 == 0 {
		window = fmt.Sprintf("%d-day", windowSeconds/86400)
	}

	minutesLeft := max((resetAt-now+59)/60, 1)
	var timeLeft string
	switch {
	case minutesLeft < 60:
		timeLeft = fmt.Sprintf("%dm", minutesLeft)
	case minutesLeft < 24*60:
		timeLeft = fmt.Sprintf("%dh", minutesLeft/60)
		if minutesLeft%60 > 0 {
			timeLeft += fmt.Sprintf(" %dm", minutesLeft%60)
		}
	default:
		hoursLeft := (minutesLeft + 59) / 60
		timeLeft = fmt.Sprintf("%dd", hoursLeft/24)
		if hoursLeft%24 > 0 {
			timeLeft += fmt.Sprintf(" %dh", hoursLeft%24)
		}
	}

	resetMinute := (resetAt + 59) / 60 * 60
	resetTime := time.Unix(resetMinute, 0).In(userUsageLimitResetZone).Format("2006-01-02 15:04 MST")
	return fmt.Sprintf("You have reached your %s usage limit. It will reset in %s, at %s. Please retry after that time.", window, timeLeft, resetTime)
}
