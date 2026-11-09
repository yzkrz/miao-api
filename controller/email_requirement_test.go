package controller

import (
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAdminUserEmailAuthorizationAndDelivery(t *testing.T) {
	user, identity := setupSecurityEnrollmentTest(t)
	mailbox := newSecurityMailbox(t)
	require.NoError(t, model.DB.Model(user).Update("role", common.RoleAdminUser).Error)
	require.NoError(t, model.PublishUserAuthCache(user.Id))
	image := common.InlineEmailImage{CID: "picture", ContentType: "image/png", Content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII="}
	draft := service.UserEmailDraft{Subject: "Test subject", HTML: "<p><b>Private body</b></p><img src=\"cid:picture\"><script>bad()</script>", Images: []common.InlineEmailImage{image}}
	recipient := &model.User{Username: "recipient", AffCode: "recipient", Email: "recipient@example.com", Role: common.RoleAdminUser, Status: common.UserStatusEnabled}
	require.NoError(t, model.DB.Create(recipient).Error)
	payload, err := common.Marshal(draft)
	require.NoError(t, err)
	send := func(role, target int, proof string, body []byte) *httptest.ResponseRecorder {
		return securityEnrollmentRequest("POST", fmt.Sprintf("/api/user/%d/email", target), string(body), proof, identity, func(c *gin.Context) { c.Set("role", role); withAccessTokenID(SendUserEmail, target)(c) })
	}
	proofFor := func(target *model.User) string {
		context, err := common.Marshal(service.AdminUserEmailContext{UserID: target.Id, Email: target.Email, Digest: draft.Digest()})
		require.NoError(t, err)
		return issueSecurityEnrollmentProof(t, identity, service.VerificationOperation{Scope: service.VerificationScopeAdminUserEmail, Context: context}, service.VerificationMethodPassword)
	}
	assert.Equal(t, http.StatusForbidden, send(common.RoleCommonUser, recipient.Id, "", payload).Code)
	assert.Equal(t, http.StatusForbidden, send(common.RoleAdminUser, recipient.Id, "", payload).Code)
	proof := proofFor(recipient)
	changed := draft
	changed.Subject = "Changed"
	changedPayload, err := common.Marshal(changed)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, send(common.RoleAdminUser, recipient.Id, proof, changedPayload).Code)
	// Wrong draft consumes the proof; a fresh ceremony is necessary.
	proof = proofFor(recipient)
	response := send(common.RoleAdminUser, recipient.Id, proof, payload)
	assert.Contains(t, response.Body.String(), `"success":true`)
	assert.Equal(t, http.StatusForbidden, send(common.RoleAdminUser, recipient.Id, proof, payload).Code)
	mailbox.mutex.Lock()
	messages := append([]string(nil), mailbox.mail[recipient.Email]...)
	mailbox.mutex.Unlock()
	require.Len(t, messages, 1)
	message, err := mail.ReadMessage(strings.NewReader(messages[0]))
	require.NoError(t, err)
	mediaType, params, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	require.NoError(t, err)
	assert.Equal(t, "multipart/related", mediaType)
	parts := multipart.NewReader(message.Body, params["boundary"])
	bodyPart, err := parts.NextPart()
	require.NoError(t, err)
	body, err := io.ReadAll(bodyPart)
	require.NoError(t, err)
	assert.Contains(t, string(body), "<b>Private body</b>")
	assert.NotContains(t, string(body), "script")
	imagePart, err := parts.NextPart()
	require.NoError(t, err)
	assert.Equal(t, "<picture>", imagePart.Header.Get("Content-ID"))
	encoded, err := io.ReadAll(imagePart)
	require.NoError(t, err)
	decoded, err := base64.StdEncoding.DecodeString(string(encoded))
	require.NoError(t, err)
	assert.Equal(t, "image/png", http.DetectContentType(decoded))
	var audit model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "user.email_send").Last(&audit).Error)
	assert.True(t, audit.Success)
	auditJSON, err := common.Marshal(audit)
	require.NoError(t, err)
	for _, secret := range []string{proof, draft.Subject, "Private body", image.Content} {
		assert.NotContains(t, string(auditJSON), secret)
	}
	for _, role := range []int{common.RoleCommonUser, common.RoleAdminUser} {
		require.NoError(t, model.DB.Model(recipient).Update("role", role).Error)
		assert.Contains(t, send(common.RoleAdminUser, recipient.Id, proofFor(recipient), payload).Body.String(), `"success":true`)
	}
	require.NoError(t, model.DB.Model(user).Update("email", "self@example.com").Error)
	user.Email = "self@example.com"
	assert.Contains(t, send(common.RoleAdminUser, user.Id, proofFor(user), payload).Body.String(), `"success":true`)
	require.NoError(t, model.DB.Model(recipient).Update("role", common.RoleRootUser).Error)
	assert.Equal(t, http.StatusForbidden, send(common.RoleRootUser, recipient.Id, "", payload).Code)
	require.NoError(t, model.DB.Model(recipient).Updates(map[string]any{"role": common.RoleCommonUser, "email": ""}).Error)
	assert.Contains(t, send(common.RoleAdminUser, recipient.Id, "", payload).Body.String(), "no valid email")
	require.NoError(t, model.DB.Model(recipient).Update("email", "recipient@example.com").Error)
	recipient.Email = "recipient@example.com"
	common.SMTPServer = ""
	common.SMTPAccount = ""
	response = send(common.RoleAdminUser, recipient.Id, proofFor(recipient), payload)
	assert.Contains(t, response.Body.String(), `"success":false`)
	audit = model.AuditLog{}
	require.NoError(t, model.LOG_DB.Where("action = ?", "user.email_send").Last(&audit).Error)
	assert.False(t, audit.Success)
}

func TestAdminEmailResendInlineImageContract(t *testing.T) {
	configureEmailDelivery(t, map[string]string{"EmailProvider": "resend", "ResendApiKey": "test-key", "ResendFrom": "sender@example.com"})
	image := common.InlineEmailImage{CID: "picture", Name: "picture.png", ContentType: "image/png", Content: "aW1hZ2U="}
	calls := 0
	http.DefaultTransport = emailHTTPTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		var body struct {
			HTML        string `json:"html"`
			Attachments []struct {
				Filename    string `json:"filename"`
				Content     string `json:"content"`
				ContentID   string `json:"content_id"`
				ContentType string `json:"content_type"`
			} `json:"attachments"`
		}
		require.NoError(t, common.DecodeJson(request.Body, &body))
		assert.Equal(t, `<img src="cid:picture">`, body.HTML)
		require.Len(t, body.Attachments, 1)
		assert.Equal(t, image.CID, body.Attachments[0].ContentID)
		assert.Equal(t, image.Name, body.Attachments[0].Filename)
		assert.Equal(t, image.ContentType, body.Attachments[0].ContentType)
		assert.Equal(t, image.Content, body.Attachments[0].Content)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"id":"test-delivery"}`))}, nil
	})
	require.NoError(t, common.SendEmailWithImages("Image", "receiver@example.com", `<img src="cid:picture">`, []common.InlineEmailImage{image}))
	assert.Equal(t, 1, calls)
}

func TestUserEmailSanitizesActiveContentAndRejectsInvalidDrafts(t *testing.T) {
	draft := service.UserEmailDraft{Subject: "Hello", HTML: `<p style="background:url(https://bad);text-align:center" onclick="bad()">safe</p><a href="javascript:bad()">link</a><img src="file:///secret"><svg onload="bad()"/><iframe src="https://bad"></iframe>`}
	clean, _, err := service.PrepareUserEmail(draft)
	require.NoError(t, err)
	assert.Contains(t, clean, "text-align:center")
	for _, unsafe := range []string{"background", "onclick", "javascript", "file:", "svg", "iframe"} {
		assert.NotContains(t, clean, unsafe)
	}
	for _, invalid := range []service.UserEmailDraft{
		{Subject: "Hi", HTML: "body\x00image"},
		{Subject: "\r\nBcc: other@example.com", HTML: "text"}, {Subject: "Hi", HTML: "<script>only</script>"},
		{Subject: "Hi", HTML: "text", Images: []common.InlineEmailImage{{CID: "x", ContentType: "image/png", Content: base64.StdEncoding.EncodeToString([]byte("not an image"))}}},
	} {
		_, _, err := service.PrepareUserEmail(invalid)
		assert.ErrorIs(t, err, service.ErrUserEmailInvalid)
	}
}
