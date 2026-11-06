package middleware

import (
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// UserConcurrencyLimit caps the relay requests a user has in flight at the
// maximum an administrator configured for that user. The slot is held until
// the handler returns, so a streaming response or a realtime session keeps it
// until it ends. Mount it after TokenAuth and the request rate limit.
//
// A failure to read the policy or the shared counter is logged and lets the
// request through, so the optional limit never blocks relays on its own.
func UserConcurrencyLimit() gin.HandlerFunc {
	return userConcurrencyLimit(false)
}

// MidjourneyUserConcurrencyLimit is UserConcurrencyLimit answering in the
// Midjourney error format.
func MidjourneyUserConcurrencyLimit() gin.HandlerFunc {
	return userConcurrencyLimit(true)
}

func userConcurrencyLimit(midjourney bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		userId := c.GetInt("id")
		snapshot, err := model.GetUserLimitSnapshot(userId)
		if err != nil {
			common.SysError(common.LogText("failed to load user limit policy: user %d, %s", userId, err.Error()))
			c.Next()
			return
		}
		if snapshot.MaxConcurrency <= 0 {
			c.Next()
			return
		}
		lease, acquired, err := service.AcquireUserConcurrency(userId, snapshot.MaxConcurrency)
		if err != nil {
			common.SysError(common.LogText("failed to check user concurrency limit: user %d, %s", userId, err.Error()))
			c.Next()
			return
		}
		if !acquired {
			c.Header("Retry-After", strconv.Itoa(service.UserConcurrencyRetryAfterSeconds))
			if midjourney {
				abortWithMidjourneyMessage(c, http.StatusTooManyRequests, constant.MjUserLimitReached, service.UserConcurrencyLimitMessage)
				return
			}
			abortWithOpenAiMessage(c, http.StatusTooManyRequests, service.UserConcurrencyLimitMessage, types.ErrorCodeUserConcurrencyLimitReached)
			return
		}
		defer lease.Release()
		c.Next()
	}
}
