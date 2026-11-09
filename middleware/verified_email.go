package middleware

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
)

// Root remains able to configure email delivery if it is unavailable. Everyone
// else must prove mailbox ownership, including addresses present before upgrade.
func allowVerifiedEmailAPI(c *gin.Context, user *model.UserBase) bool {
	allowed, err := model.HasVerifiedEmailForAPI(user.Id)
	if err != nil {
		abortWithOpenAiMessage(c, http.StatusInternalServerError, "Unable to verify account email status. Please retry later.")
		return false
	}
	if allowed {
		return true
	}
	site := strings.TrimRight(system_setting.ServerAddress, "/")
	message := fmt.Sprintf("API access is disabled until you verify an email address. Sign in to %s and bind and verify your email address to restore API access.", site)
	abortWithOpenAiMessage(c, http.StatusForbidden, message, types.ErrorCodeAccessDenied)
	return false
}

// VerifiedEmailRequired also protects session-authenticated relay entry points.
func VerifiedEmailRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := model.GetUserCache(c.GetInt("id"))
		if err != nil {
			abortWithOpenAiMessage(c, http.StatusInternalServerError, "Unable to verify account email status. Please retry later.")
			return
		}
		if allowVerifiedEmailAPI(c, user) {
			c.Next()
		}
	}
}
