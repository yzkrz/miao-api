package service

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"

	"github.com/bytedance/gopkg/util/gopool"
	"github.com/go-redis/redis/v8"
)

const (
	// UserConcurrencyRetryAfterSeconds is the Retry-After a request rejected by
	// the concurrency limit carries.
	UserConcurrencyRetryAfterSeconds = 5
	// UserConcurrencyLimitMessage is the error of a request rejected by the
	// concurrency limit. Like the usage limit message it is English whatever
	// language the user reads.
	UserConcurrencyLimitMessage = "Concurrency limit reached. Please reduce concurrency and retry later."

	userConcurrencyLeaseTTL      = 90 * time.Second
	userConcurrencyRenewInterval = 30 * time.Second
	userConcurrencyRedisTimeout  = 2 * time.Second
)

// userConcurrencyAcquireScript drops expired leases, then adds one lease when
// the user is below the limit. KEYS[1] = lease set; ARGV = now ms, limit,
// lease expiry ms, lease id, key TTL ms. Returns 1 when acquired.
const userConcurrencyAcquireScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1`

var userConcurrencyAcquire = redis.NewScript(userConcurrencyAcquireScript)

// UserConcurrencyLease is one in-flight relay request counted against the
// user's concurrency limit. Release frees it exactly once.
type UserConcurrencyLease struct {
	userId int
	id     string // set for Redis leases only
	once   sync.Once
}

var (
	userConcurrencyMemoryMu sync.Mutex
	userConcurrencyMemory   = map[int]int{}

	// userConcurrencyRedisLeases holds this instance's live Redis leases so a
	// single renewer can extend them; a crashed instance's leases expire.
	userConcurrencyRedisLeases sync.Map
	userConcurrencyRenewOnce   sync.Once
)

func userConcurrencyKey(userId int) string {
	return "user_concurrency:" + strconv.Itoa(userId)
}

// AcquireUserConcurrency takes one in-flight slot for the user. It reports
// false when the user already has maxConcurrency requests in flight. With
// Redis the count is shared by all instances; without it each instance counts
// its own requests.
func AcquireUserConcurrency(userId int, maxConcurrency int) (*UserConcurrencyLease, bool, error) {
	if !common.RedisEnabled || common.RDB == nil {
		userConcurrencyMemoryMu.Lock()
		defer userConcurrencyMemoryMu.Unlock()
		if userConcurrencyMemory[userId] >= maxConcurrency {
			return nil, false, nil
		}
		userConcurrencyMemory[userId]++
		return &UserConcurrencyLease{userId: userId}, true, nil
	}

	lease := &UserConcurrencyLease{userId: userId, id: common.GetUUID()}
	now := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), userConcurrencyRedisTimeout)
	defer cancel()
	acquired, err := userConcurrencyAcquire.Run(ctx, common.RDB, []string{userConcurrencyKey(userId)},
		now.UnixMilli(),
		maxConcurrency,
		now.Add(userConcurrencyLeaseTTL).UnixMilli(),
		lease.id,
		userConcurrencyLeaseTTL.Milliseconds(),
	).Int()
	if err != nil {
		return nil, false, err
	}
	if acquired != 1 {
		return nil, false, nil
	}
	userConcurrencyRedisLeases.Store(lease, struct{}{})
	userConcurrencyRenewOnce.Do(func() {
		gopool.Go(renewUserConcurrencyLeases)
	})
	return lease, true, nil
}

func (l *UserConcurrencyLease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		if l.id == "" {
			userConcurrencyMemoryMu.Lock()
			defer userConcurrencyMemoryMu.Unlock()
			userConcurrencyMemory[l.userId]--
			if userConcurrencyMemory[l.userId] <= 0 {
				delete(userConcurrencyMemory, l.userId)
			}
			return
		}
		// Leave the renewal set first: renewal uses ZADD XX, so it can never
		// bring back a lease removed below.
		userConcurrencyRedisLeases.Delete(l)
		ctx, cancel := context.WithTimeout(context.Background(), userConcurrencyRedisTimeout)
		defer cancel()
		if err := common.RDB.ZRem(ctx, userConcurrencyKey(l.userId), l.id).Err(); err != nil {
			common.SysError(common.LogText("failed to release user concurrency lease: user %d, %s", l.userId, err.Error()))
		}
	})
}

// renewUserConcurrencyLeases keeps long-running requests (streams, realtime
// sessions) counted: their leases would otherwise expire after the lease TTL.
func renewUserConcurrencyLeases() {
	ticker := time.NewTicker(userConcurrencyRenewInterval)
	defer ticker.Stop()
	for range ticker.C {
		if !common.RedisEnabled || common.RDB == nil {
			continue
		}
		expiry := float64(time.Now().Add(userConcurrencyLeaseTTL).UnixMilli())
		ctx, cancel := context.WithTimeout(context.Background(), userConcurrencyRedisTimeout)
		pipe := common.RDB.Pipeline()
		count := 0
		userConcurrencyRedisLeases.Range(func(key, _ any) bool {
			lease := key.(*UserConcurrencyLease)
			userKey := userConcurrencyKey(lease.userId)
			pipe.ZAddXX(ctx, userKey, &redis.Z{Score: expiry, Member: lease.id})
			pipe.PExpire(ctx, userKey, userConcurrencyLeaseTTL)
			count++
			return true
		})
		if count > 0 {
			if _, err := pipe.Exec(ctx); err != nil {
				common.SysError(common.LogText("failed to renew user concurrency leases: %s", err.Error()))
			}
		}
		cancel()
	}
}

// GetUserConcurrencyInUse returns how many relay requests of the user are in
// flight (on this instance only when Redis is disabled).
func GetUserConcurrencyInUse(userId int) (int, error) {
	if !common.RedisEnabled || common.RDB == nil {
		userConcurrencyMemoryMu.Lock()
		defer userConcurrencyMemoryMu.Unlock()
		return userConcurrencyMemory[userId], nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), userConcurrencyRedisTimeout)
	defer cancel()
	count, err := common.RDB.ZCount(ctx, userConcurrencyKey(userId), "("+strconv.FormatInt(time.Now().UnixMilli(), 10), "+inf").Result()
	return int(count), err
}
