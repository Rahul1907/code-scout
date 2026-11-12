import asyncio
import random
import time
from collections.abc import Awaitable, Callable

import redis.asyncio as redis_async

# Atomic Redis token-bucket script.
# KEYS[1] = bucket hash key
# ARGV[1] = capacity (float)
# ARGV[2] = refill_rate_per_sec (float)
# ARGV[3] = now_seconds (float)
# ARGV[4] = requested_tokens (float)
# Returns {allowed (1 or 0), wait_seconds (stringified float)}
TOKEN_BUCKET_LUA = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil or last_refill == nil then
  tokens = capacity
  last_refill = now
else
  local elapsed = math.max(0, now - last_refill)
  tokens = math.min(capacity, tokens + elapsed * refill_rate)
  last_refill = now
end

if tokens >= requested then
  tokens = tokens - requested
  redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
  local ttl = math.max(10, math.ceil(capacity / math.max(refill_rate, 0.001)) * 2)
  redis.call('EXPIRE', key, ttl)
  return {1, "0"}
else
  redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
  local ttl = math.max(10, math.ceil(capacity / math.max(refill_rate, 0.001)) * 2)
  redis.call('EXPIRE', key, ttl)
  local deficit = requested - tokens
  local wait_seconds = deficit / math.max(refill_rate, 0.001)
  return {0, tostring(wait_seconds)}
end
"""


class RedisTokenBucketRateLimiter:
    """Distributed token-bucket rate limiter backed by Redis."""

    def __init__(
        self,
        redis_client: redis_async.Redis,
        rpm_limit: int,
        key: str = "codescout:llm:ratelimit",
        capacity: int | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if rpm_limit <= 0:
            raise ValueError("rpm_limit must be positive")
        self._redis = redis_client
        self.rpm_limit = rpm_limit
        self.capacity = float(capacity if capacity is not None else rpm_limit)
        if self.capacity <= 0:
            raise ValueError("capacity must be positive")
        self.refill_rate_per_sec = float(rpm_limit) / 60.0
        self.key = key
        self._clock = clock
        self._sleep = sleep_fn
        self._script = self._redis.register_script(TOKEN_BUCKET_LUA)

    async def try_acquire(self, tokens: int = 1) -> tuple[bool, float]:
        if tokens <= 0:
            raise ValueError("tokens must be positive")
        if tokens > self.capacity:
            raise ValueError(
                f"requested tokens ({tokens}) exceed bucket capacity ({self.capacity})"
            )

        now = self._clock()
        result = await self._script(
            keys=[self.key],
            args=[
                str(self.capacity),
                str(self.refill_rate_per_sec),
                str(now),
                str(float(tokens)),
            ],
        )
        allowed = int(result[0]) == 1
        wait_seconds = float(result[1])
        return allowed, wait_seconds

    async def acquire(self, tokens: int = 1, max_wait_seconds: float = 120.0) -> None:
        deadline = self._clock() + max_wait_seconds
        while True:
            allowed, wait_seconds = await self.try_acquire(tokens=tokens)
            if allowed:
                return
            remaining_budget = deadline - self._clock()
            if remaining_budget <= 0:
                raise TimeoutError("Timed out waiting for LLM rate limit token")
            jitter = random.uniform(0.01, 0.05)
            delay = min(wait_seconds + jitter, remaining_budget)
            await self._sleep(max(delay, 0.01))

