package controller

import (
	"net/http"
	"net/mail"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func SendUserEmail(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if c.GetInt("role") < common.RoleAdminUser {
		common.ApiErrorStatus(c, http.StatusForbidden, common.NewMessage("Unauthorized, insufficient privileges"))
		return
	}
	user, err := model.GetUserById(id, false)
	if err != nil {
		common.ApiErrorT(c, "User does not exist")
		return
	}
	if user.Role >= common.RoleRootUser {
		common.ApiErrorStatus(c, http.StatusForbidden, common.NewMessage("Email cannot be sent to a root account."))
		return
	}
	recipient, err := mail.ParseAddress(user.Email)
	if err != nil || recipient.Address != user.Email || strings.ContainsAny(user.Email, "\r\n\x00") {
		common.ApiErrorT(c, "This user has no valid email address.")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8*1024*1024)
	var draft service.UserEmailDraft
	if common.DecodeJson(c.Request.Body, &draft) != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	content, images, err := service.PrepareUserEmail(draft)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if requireAdminUserProof(c, service.VerificationScopeAdminUserEmail, service.AdminUserEmailContext{UserID: id, Email: user.Email, Digest: draft.Digest()}) == nil {
		return
	}
	success := false
	defer func() {
		params := map[string]any{"target_user_id": user.Id, "success": success, "image_count": len(images)}
		info := &model.AuditRequestInfo{Method: c.Request.Method, Route: c.FullPath(), Path: c.FullPath(), Status: c.Writer.Status(), Success: success}
		model.RecordOperationAuditLog(c.GetInt("id"), c.GetInt("role"), auditContentEN("user.email_send", params), c.ClientIP(), "user.email_send", params, auditOperatorInfo(c), info, c)
		markAuditLogged(c)
	}()
	if err := common.SendEmailWithImages(draft.Subject, user.Email, content, images); err != nil {
		common.ApiErrorT(c, "Email delivery failed. Check the email settings before retrying.")
		return
	}
	success = true
	common.ApiSuccess(c, nil)
}
