
const AppError = require('../utils/appError');
const logger = require('../utils/logger');

const TOKEN_BUCKET_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local now       = tonumber(ARGV[3])
local cost      = tonumber(ARGV[4])
local ttl       = tonumber(ARGV[5])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts     = tonumber(bucket[2])

-- First time we have seen this client: hand them a full bucket.
if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill for the time elapsed since we last looked. This is the whole trick:
-- we do not need a background job ticking tokens in, we just compute how many
-- WOULD have arrived and cap at capacity.
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + (elapsed * refill))

local allowed = 0
local retry_after = 0

if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  -- How long until enough tokens exist for this request?
  local deficit = cost - tokens
  retry_after = math.ceil((deficit / refill) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)

return { allowed, math.floor(tokens), retry_after }
`;

let sha = null;

async function consume(redis, key, { capacity, refillPerSec, cost = 1, ttl = 3600 }) {
  const now = Date.now();
  const args = [key, capacity, refillPerSec, now, cost, ttl];

  try {
    if (!sha) sha = await redis.script('LOAD', TOKEN_BUCKET_LUA);
    const [allowed, tokens, retryAfterMs] = await redis.evalsha(sha, 1, ...args);
    return { allowed: allowed === 1, tokens, retryAfterMs };
  } catch (err) {
    if (String(err.message).includes('NOSCRIPT')) {
      sha = await redis.script('LOAD', TOKEN_BUCKET_LUA);
      const [allowed, tokens, retryAfterMs] = await redis.evalsha(sha, 1, ...args);
      return { allowed: allowed === 1, tokens, retryAfterMs };
    }

    logger.error({ err }, 'ratelimit: Redis unavailable — FAILING OPEN');
    return { allowed: true, tokens: -1, retryAfterMs: 0, degraded: true };
  }
}

function jitter(ms) {
  return Math.ceil(ms * (1 + Math.random() * 0.5));
}

function createLimiter(redis, {
  capacity = 60,
  refillPerSec = 1,
  keyFn = (req) => req.user?.id || req.ip,
  name = 'api',
} = {}) {
  return async function limiter(req, res, next) {
    const key = `rl:${name}:${keyFn(req)}`;
    const { allowed, tokens, retryAfterMs, degraded } =
      await consume(redis, key, { capacity, refillPerSec });

    res.setHeader('X-RateLimit-Limit', capacity);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, tokens));
    if (degraded) res.setHeader('X-RateLimit-Degraded', 'true');

    if (allowed) return next();

    const wait = jitter(retryAfterMs);
    res.setHeader('Retry-After', Math.ceil(wait / 1000));
    return next(
      new AppError('Too many requests. Please slow down.', 429, {
        code: 'RATE_LIMITED',
        retryable: true,
        details: { retry_after_ms: wait },
      })
    );
  };
}

function createSyncLimiter(redis, {
  capacity = 500,
  refillPerSec = 5,
} = {}) {
  return async function syncLimiter(req, res, next) {
    const deviceId = req.ctx?.deviceId || req.ip;
    const cost = Math.max(1, Array.isArray(req.body?.mutations) ? req.body.mutations.length : 1);

    const max = Number(process.env.SYNC_MAX_BATCH || 200);
    if (cost > max) {
      return next(
        new AppError(`Too many mutations in one batch (${cost} > ${max}). Split it.`, 413, {
          code: 'SYNC_BATCH_TOO_LARGE',
          retryable: false,
          details: { max_batch: max },
        })
      );
    }

    const { allowed, tokens, retryAfterMs, degraded } = await consume(
      redis, `rl:sync:${deviceId}`, { capacity, refillPerSec, cost, ttl: 7200 }
    );

    res.setHeader('X-RateLimit-Limit', capacity);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, tokens));
    if (degraded) res.setHeader('X-RateLimit-Degraded', 'true');

    if (allowed) return next();

    const wait = jitter(retryAfterMs);
    res.setHeader('Retry-After', Math.ceil(wait / 1000));

    logger.warn({ deviceId, cost, tokens }, 'ratelimit: sync throttled');

    return next(
      new AppError(
        'Sync throttled. Your work is safe — the device will retry automatically.',
        429,
        { code: 'SYNC_RATE_LIMITED', retryable: true, details: { retry_after_ms: wait } }
      )
    );
  };
}

function createAuthLimiter(redis) {
  return createLimiter(redis, {
    name: 'auth',
    capacity: 5,
    refillPerSec: 1 / 60,
    keyFn: (req) => `${req.ip}:${req.body?.phone || 'anon'}`,
  });
}

module.exports = {
  consume,
  createLimiter,
  createSyncLimiter,
  createAuthLimiter,
  TOKEN_BUCKET_LUA,
};
