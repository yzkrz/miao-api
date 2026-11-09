package controller

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const managedTokenOwnerKey = "managed_token_owner"
const managedTokenSessionPurpose = "admin_token_management"

type managedTokenAuthorization struct {
	UserID        int                          `json:"target_user_id"`
	Authorization *model.AuthFlowAuthorization `json:"authorization"`
}

// StartUserTokenManagement exchanges a consumed step-up proof for a bounded,
// revocable capability for this owner. It never stores the password or proof.
func StartUserTokenManagement(c *gin.Context) {
	ownerID := tokenRequestOwnerID(c)
	authorization := requireAdminUserProof(c, service.VerificationScopeAdminUserTokens, service.AdminUserTokensContext{UserID: ownerID, Action: "manage", TokenIDs: []int{}})
	if authorization == nil {
		return
	}
	payload, err := common.Marshal(managedTokenAuthorization{UserID: ownerID, Authorization: authorization})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	token, flow, err := model.CreateAuthFlow(model.AuthFlowCreate{Purpose: managedTokenSessionPurpose, UserId: authorization.UserID, SessionId: authorization.SessionID, Payload: string(payload), ExpiresAt: time.Now().Add(30 * time.Minute)})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"management_token": token, "expires_at": flow.ExpiresAt.Unix()})
}

// EndUserTokenManagement revokes only this drawer's capability. Session and
// owner binding prevent one drawer from revoking another account's capability.
func EndUserTokenManagement(c *gin.Context) {
	if !validUserTokenManagement(c) {
		return
	}
	identity, _ := middleware.GetStepUpIdentity(c)
	_, err := model.ConsumeAuthFlow(strings.TrimSpace(c.GetHeader("X-Key-Management-Session")), model.AuthFlowMatch{Purpose: managedTokenSessionPurpose, UserId: identity.UserID, SessionId: identity.SessionID})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

func validUserTokenManagement(c *gin.Context) (valid bool) {
	defer func() {
		if !valid {
			c.Set("security_error_code", "SECURITY_PROOF_INVALID")
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "SECURITY_PROOF_INVALID", "message": "Security verification is no longer valid. Please verify again."})
		}
	}()
	identity, ok := middleware.GetStepUpIdentity(c)
	if !ok {
		return false
	}
	flow, err := model.GetAuthFlow(strings.TrimSpace(c.GetHeader("X-Key-Management-Session")), model.AuthFlowMatch{Purpose: managedTokenSessionPurpose, UserId: identity.UserID, SessionId: identity.SessionID})
	if err != nil {
		return false
	}
	var state managedTokenAuthorization
	if common.UnmarshalJsonStr(flow.Payload, &state) != nil || state.UserID != tokenRequestOwnerID(c) {
		return false
	}
	context, err := common.Marshal(service.AdminUserTokensContext{UserID: state.UserID, Action: "manage", TokenIDs: []int{}})
	if err != nil {
		return false
	}
	return service.ValidateFlowAuthorization(identity, service.VerificationOperation{Scope: service.VerificationScopeAdminUserTokens, Context: context}, state.Authorization) == nil
}

// AuthorizeUserTokenManagement keeps the authenticated operator intact while
// selecting the owner used by the existing token handlers.
func AuthorizeUserTokenManagement(c *gin.Context) {
	if c.GetInt("role") < common.RoleAdminUser {
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
	if user.Role >= common.RoleRootUser && c.GetInt("role") != common.RoleRootUser {
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
	if c.GetHeader("X-Key-Management-Session") != "" {
		return validUserTokenManagement(c)
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
