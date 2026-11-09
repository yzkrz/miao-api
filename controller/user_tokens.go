package controller

import (
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const managedTokenOwnerKey = "managed_token_owner"

// AuthorizeUserTokenManagement keeps the authenticated operator intact while
// selecting the owner used by the existing token handlers.
func AuthorizeUserTokenManagement(c *gin.Context) {
	if c.GetInt("role") < common.RoleAdminUser || !authz.Can(c.GetInt("id"), c.GetInt("role"), authz.AuditRead) {
		common.ApiErrorStatus(c, http.StatusForbidden, common.NewMessage("You do not have permission to perform this action."))
		c.Abort()
		return
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		c.Abort()
		return
	}
	user, err := model.GetUserById(id, false)
	if err != nil {
		common.ApiErrorT(c, "User does not exist")
		c.Abort()
		return
	}
	if user.Role >= common.RoleRootUser {
		common.ApiErrorStatus(c, http.StatusForbidden, common.NewMessage("No permission to access users of same or higher level"))
		c.Abort()
		return
	}
	c.Set(managedTokenOwnerKey, user)
	c.Next()
}

func tokenRequestOwnerID(c *gin.Context) int {
	if value, ok := c.Get(managedTokenOwnerKey); ok {
		return value.(*model.User).Id
	}
	return c.GetInt("id")
}

func tokenRequestID(c *gin.Context) (int, error) {
	if id := c.Param("token_id"); id != "" {
		return strconv.Atoi(id)
	}
	return strconv.Atoi(c.Param("id"))
}

func requireManagedTokenProof(c *gin.Context, action string, ids []int, count int) bool {
	if _, ok := c.Get(managedTokenOwnerKey); !ok {
		return true
	}
	if ids == nil {
		ids = []int{}
	}
	return requireAdminUserProof(c, service.VerificationScopeAdminUserTokens, service.AdminUserTokensContext{
		UserID: tokenRequestOwnerID(c), Action: action, TokenIDs: ids, Count: count,
	}) != nil
}

// AddUserTokensBatch is atomic so a retry cannot silently duplicate a partially
// created batch. The proof is consumed once for the whole requested count.
func AddUserTokensBatch(c *gin.Context) {
	var request struct {
		Tokens []tokenRequest `json:"tokens"`
	}
	if c.ShouldBindJSON(&request) != nil || len(request.Tokens) == 0 || len(request.Tokens) > 100 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	ownerID := tokenRequestOwnerID(c)
	count, err := model.CountUserTokens(ownerID)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	maxTokens := operation_setting.GetMaxUserTokens()
	if int(count)+len(request.Tokens) > maxTokens {
		common.ApiErrorT(c, "Maximum number of tokens reached ({{max}})", map[string]any{"max": maxTokens})
		return
	}
	if !requireManagedTokenProof(c, "create", nil, len(request.Tokens)) {
		return
	}
	tokens := make([]model.Token, 0, len(request.Tokens))
	for _, input := range request.Tokens {
		token, ok := prepareTokenCreation(c, input)
		if !ok {
			return
		}
		tokens = append(tokens, *token)
	}
	if err := model.DB.Transaction(func(tx *gorm.DB) error {
		return tx.Create(&tokens).Error
	}); err != nil {
		common.ApiError(c, err)
		return
	}
	params := tokenAuditParams(c)
	params["count"] = len(tokens)
	common.SetContextKey(c, constant.ContextKeyTokenAuditSucceeded, true)
	common.ApiSuccess(c, gin.H{"count": len(tokens)})
}
