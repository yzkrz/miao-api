package service

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const (
	testFiveHours  = int64(5 * 3600)
	testSevenDays  = int64(7 * 86400)
	testLimitUser  = 9101
	testLimitQuota = int64(100)
)

func setupUserLimitTestDB(t *testing.T) {
	t.Helper()
	previousDB, previousBatch := model.DB, common.BatchUpdateEnabled
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserLimitPolicy{}, &model.UserUsageWindow{}))
	model.DB = db
	common.BatchUpdateEnabled = false
	model.InvalidateUserLimitSnapshot(testLimitUser)
	t.Cleanup(func() {
		model.InvalidateUserLimitSnapshot(testLimitUser)
		model.DB = previousDB
		common.BatchUpdateEnabled = previousBatch
		_ = sqlDB.Close()
	})
}

func setUsageWindowState(t *testing.T, windowSeconds int64, windowStart int64, used int64) {
	t.Helper()
	require.NoError(t, model.DB.Model(&model.UserUsageWindow{}).
		Where("user_id = ? AND window_seconds = ?", testLimitUser, windowSeconds).
		Updates(map[string]any{"window_start": windowStart, "used_quota": used}).Error)
}

func getUsageWindowState(t *testing.T, windowSeconds int64) model.UserUsageWindow {
	t.Helper()
	var window model.UserUsageWindow
	require.NoError(t, model.DB.Where("user_id = ? AND window_seconds = ?", testLimitUser, windowSeconds).First(&window).Error)
	return window
}

func newUserLimitTestContext() (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	common.SetContextKey(c, constant.ContextKeyUserSetting, dto.UserSetting{Language: "en"})
	return c, recorder
}

func TestRecordUserUsageWindowsFollowsFixedWindowLifecycle(t *testing.T) {
	now := common.GetTimestamp()
	activeStart := now - 600
	expiredStart := now - testFiveHours - 1
	cases := []struct {
		name       string
		start      int64
		used       int64
		delta      int
		wantOpened bool // window_start moved to the settlement time
		wantStart  int64
		wantUsed   int64
	}{
		{name: "idle window opens on first charge", start: 0, used: 0, delta: 30, wantOpened: true, wantUsed: 30},
		{name: "active window accumulates charges", start: activeStart, used: 40, delta: 25, wantStart: activeStart, wantUsed: 65},
		{name: "refund in active window clamps at zero", start: activeStart, used: 40, delta: -70, wantStart: activeStart, wantUsed: 0},
		{name: "expired window reopens with only the new charge", start: expiredStart, used: 90, delta: 15, wantOpened: true, wantUsed: 15},
		{name: "refund after the window expired is ignored", start: expiredStart, used: 90, delta: -10, wantStart: expiredStart, wantUsed: 90},
		{name: "refund to an idle window is ignored", start: 0, used: 0, delta: -10, wantStart: 0, wantUsed: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setupUserLimitTestDB(t)
			require.NoError(t, model.SaveUserLimitPolicy(testLimitUser, 0, []model.UserUsageRule{
				{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true},
			}))
			setUsageWindowState(t, testFiveHours, tc.start, tc.used)

			model.RecordUserUsageWindows(testLimitUser, tc.delta)

			window := getUsageWindowState(t, testFiveHours)
			assert.Equal(t, tc.wantUsed, window.UsedQuota)
			if tc.wantOpened {
				assert.GreaterOrEqual(t, window.WindowStart, now)
				return
			}
			assert.Equal(t, tc.wantStart, window.WindowStart)
		})
	}
}

func TestUsageWindowsSkipPlaygroundUsageAndKeepDisabledRules(t *testing.T) {
	setupUserLimitTestDB(t)
	require.NoError(t, model.SaveUserLimitPolicy(testLimitUser, 0, []model.UserUsageRule{
		{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: false},
	}))

	model.UpdatePlaygroundUserUsedQuotaAndRequestCount(testLimitUser, 50)
	assert.Zero(t, getUsageWindowState(t, testFiveHours).WindowStart, "playground usage must not open a window")

	model.UpdateUserUsedQuotaAndRequestCount(testLimitUser, 50)
	window := getUsageWindowState(t, testFiveHours)
	assert.Positive(t, window.WindowStart, "a disabled rule still records usage")
	assert.Equal(t, int64(50), window.UsedQuota)
}

func TestSaveUserLimitPolicyKeepsWindowsOfUnchangedRules(t *testing.T) {
	setupUserLimitTestDB(t)
	require.NoError(t, model.SaveUserLimitPolicy(testLimitUser, 2, []model.UserUsageRule{
		{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true},
		{WindowSeconds: testSevenDays, QuotaLimit: testLimitQuota, Enabled: true},
	}))
	model.RecordUserUsageWindows(testLimitUser, 40)

	// Raise the 5h limit and drop the 7d rule.
	require.NoError(t, model.SaveUserLimitPolicy(testLimitUser, 2, []model.UserUsageRule{
		{WindowSeconds: testFiveHours, QuotaLimit: 500, Enabled: true},
	}))
	windows, err := model.GetUserUsageWindows(testLimitUser)
	require.NoError(t, err)
	require.Len(t, windows, 1)
	assert.Equal(t, testFiveHours, windows[0].WindowSeconds)
	assert.Equal(t, int64(40), windows[0].UsedQuota)

	snapshot, err := model.GetUserLimitSnapshot(testLimitUser)
	require.NoError(t, err)
	assert.Equal(t, 2, snapshot.MaxConcurrency)
	assert.Equal(t, []model.UserUsageRule{{WindowSeconds: testFiveHours, QuotaLimit: 500, Enabled: true}}, snapshot.Rules)

	require.NoError(t, model.SaveUserLimitPolicy(testLimitUser, 0, nil))
	snapshot, err = model.GetUserLimitSnapshot(testLimitUser)
	require.NoError(t, err)
	assert.Equal(t, model.UserLimitSnapshot{}, snapshot)
	windows, err = model.GetUserUsageWindows(testLimitUser)
	require.NoError(t, err)
	assert.Empty(t, windows)
}

func TestCheckUserUsageLimit(t *testing.T) {
	now := common.GetTimestamp()
	type windowState struct {
		start int64
		used  int64
	}
	cases := []struct {
		name           string
		rules          []model.UserUsageRule
		states         map[int64]windowState
		pending        int64
		wantBlocked    bool
		wantMessage    string
		wantRetryAfter int64
	}{
		{
			name:  "active window under the limit passes",
			rules: []model.UserUsageRule{{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true}},
			states: map[int64]windowState{
				testFiveHours: {start: now - 600, used: testLimitQuota - 1},
			},
		},
		{
			name:  "window used up to the limit blocks until it resets",
			rules: []model.UserUsageRule{{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true}},
			states: map[int64]windowState{
				testFiveHours: {start: now - 600, used: testLimitQuota},
			},
			wantBlocked:    true,
			wantMessage:    "You have reached the 5-hour usage limit.",
			wantRetryAfter: testFiveHours - 600,
		},
		{
			name:  "disabled rule never blocks",
			rules: []model.UserUsageRule{{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: false}},
			states: map[int64]windowState{
				testFiveHours: {start: now - 600, used: testLimitQuota * 2},
			},
		},
		{
			name:  "expired window no longer blocks",
			rules: []model.UserUsageRule{{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true}},
			states: map[int64]windowState{
				testFiveHours: {start: now - testFiveHours, used: testLimitQuota * 2},
			},
		},
		{
			name: "several used-up windows report the one that resets last",
			rules: []model.UserUsageRule{
				{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true},
				{WindowSeconds: testSevenDays, QuotaLimit: testLimitQuota, Enabled: true},
			},
			states: map[int64]windowState{
				testFiveHours: {start: now - 600, used: testLimitQuota},
				testSevenDays: {start: now - 3600, used: testLimitQuota},
			},
			wantBlocked:    true,
			wantMessage:    "You have reached the 7-day usage limit.",
			wantRetryAfter: testSevenDays - 3600,
		},
		{
			name:           "pending realtime charges can use up an idle window",
			rules:          []model.UserUsageRule{{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true}},
			pending:        testLimitQuota,
			wantBlocked:    true,
			wantMessage:    "You have reached the 5-hour usage limit.",
			wantRetryAfter: testFiveHours,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setupUserLimitTestDB(t)
			require.NoError(t, model.SaveUserLimitPolicy(testLimitUser, 0, tc.rules))
			for windowSeconds, state := range tc.states {
				setUsageWindowState(t, windowSeconds, state.start, state.used)
			}
			c, recorder := newUserLimitTestContext()

			apiErr := CheckUserUsageLimit(c, testLimitUser, tc.pending)

			if !tc.wantBlocked {
				assert.Nil(t, apiErr)
				assert.Empty(t, recorder.Header().Get("Retry-After"))
				return
			}
			require.NotNil(t, apiErr)
			assert.Equal(t, http.StatusTooManyRequests, apiErr.StatusCode)
			assert.Equal(t, types.ErrorCodeUserUsageLimitReached, apiErr.GetErrorCode())
			assert.Equal(t, tc.wantMessage, apiErr.Error())
			retryAfter, err := strconv.ParseInt(recorder.Header().Get("Retry-After"), 10, 64)
			require.NoError(t, err)
			// The check reads the clock again; allow for a second passing.
			assert.InDelta(t, tc.wantRetryAfter, retryAfter, 1)
		})
	}
}

func TestCheckUserUsageLimitLetsRequestsThroughWhenPolicyCannotBeRead(t *testing.T) {
	previousDB := model.DB
	// No user limit tables: every policy read fails.
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	model.InvalidateUserLimitSnapshot(testLimitUser)
	t.Cleanup(func() { model.DB = previousDB })
	c, recorder := newUserLimitTestContext()

	assert.Nil(t, CheckUserUsageLimit(c, testLimitUser, 0))
	assert.Empty(t, recorder.Header().Get("Retry-After"))
}

func TestPreConsumeBillingAppliesUsageLimitOutsidePlayground(t *testing.T) {
	cases := []struct {
		name       string
		modelName  string
		scoped     bool
		playground bool
		wantCode   types.ErrorCode
	}{
		{name: "relay request is blocked by the used-up window", wantCode: types.ErrorCodeUserUsageLimitReached},
		{name: "selected original model is blocked", modelName: "alpha", scoped: true, wantCode: types.ErrorCodeUserUsageLimitReached},
		{name: "another original model reaches ordinary wallet validation", modelName: "beta", scoped: true, wantCode: types.ErrorCodeInsufficientUserQuota},
		// The user has no wallet quota, so a request that skips the usage
		// limit fails later with insufficient quota instead.
		{name: "playground request skips the usage limit", playground: true, wantCode: types.ErrorCodeInsufficientUserQuota},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setupUserLimitTestDB(t)
			require.NoError(t, model.DB.Create(&model.User{Id: testLimitUser, Username: "limit_user", Status: common.UserStatusEnabled}).Error)
			var models []string
			if tc.scoped {
				models = []string{"alpha"}
			}
			require.NoError(t, model.SaveUserLimitPolicy(testLimitUser, 0, []model.UserUsageRule{
				{WindowSeconds: testFiveHours, QuotaLimit: testLimitQuota, Enabled: true, Models: models},
			}))
			setUsageWindowState(t, testFiveHours, common.GetTimestamp()-600, testLimitQuota)
			c, _ := newUserLimitTestContext()
			info := &relaycommon.RelayInfo{UserId: testLimitUser, IsPlayground: tc.playground, OriginModelName: tc.modelName}
			info.UserSetting.BillingPreference = "wallet_only"

			apiErr := PreConsumeBilling(c, 10, info)

			require.NotNil(t, apiErr)
			assert.Equal(t, tc.wantCode, apiErr.GetErrorCode())
		})
	}
}

func useUserConcurrencyRedis(t *testing.T) *redis.Client {
	t.Helper()
	previousEnabled, previousClient := common.RedisEnabled, common.RDB
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	common.RedisEnabled = true
	common.RDB = client
	t.Cleanup(func() {
		_ = client.Close()
		common.RedisEnabled = previousEnabled
		common.RDB = previousClient
	})
	return client
}

func TestUserConcurrencyLeasesCountInFlightRequests(t *testing.T) {
	for i, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			if backend == "redis" {
				useUserConcurrencyRedis(t)
			} else {
				previousEnabled := common.RedisEnabled
				common.RedisEnabled = false
				t.Cleanup(func() { common.RedisEnabled = previousEnabled })
			}
			userId := 9200 + i

			first, acquired, err := AcquireUserConcurrency(userId, 2)
			require.NoError(t, err)
			require.True(t, acquired)
			second, acquired, err := AcquireUserConcurrency(userId, 2)
			require.NoError(t, err)
			require.True(t, acquired)
			_, acquired, err = AcquireUserConcurrency(userId, 2)
			require.NoError(t, err)
			assert.False(t, acquired, "a third request exceeds the limit of 2")

			first.Release()
			first.Release() // releasing twice frees one slot only
			inUse, err := GetUserConcurrencyInUse(userId)
			require.NoError(t, err)
			assert.Equal(t, 1, inUse)

			third, acquired, err := AcquireUserConcurrency(userId, 2)
			require.NoError(t, err)
			assert.True(t, acquired, "a released slot can be taken again")
			second.Release()
			third.Release()
			inUse, err = GetUserConcurrencyInUse(userId)
			require.NoError(t, err)
			assert.Zero(t, inUse)
		})
	}
}

func TestRedisUserConcurrencyIgnoresExpiredLeases(t *testing.T) {
	client := useUserConcurrencyRedis(t)
	userId := 9210
	// A lease left behind by an instance that stopped without releasing it.
	require.NoError(t, client.ZAdd(t.Context(), userConcurrencyKey(userId), &redis.Z{
		Score:  float64(time.Now().Add(-time.Second).UnixMilli()),
		Member: "crashed-instance-lease",
	}).Err())

	lease, acquired, err := AcquireUserConcurrency(userId, 1)
	require.NoError(t, err)
	require.True(t, acquired, "an expired lease no longer occupies a slot")
	inUse, err := GetUserConcurrencyInUse(userId)
	require.NoError(t, err)
	assert.Equal(t, 1, inUse)
	lease.Release()
}
