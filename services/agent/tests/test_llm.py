from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from openai import APIStatusError

from app.config import Settings
from app.llm.client import LLMClient
from app.llm.rate_limiter import RedisTokenBucketRateLimiter


class FakeRedis:
    """In-memory mock mimicking Redis register_script for deterministic token-bucket tests."""

    def __init__(self) -> None:
        self.tokens: float | None = None
        self.last_refill: float | None = None

    def register_script(self, _script: str):
        async def _run(keys: list[str], args: list[str]):
            capacity = float(args[0])
            refill_rate = float(args[1])
            now = float(args[2])
            requested = float(args[3])

            if self.tokens is None or self.last_refill is None:
                self.tokens = capacity
                self.last_refill = now
            else:
                elapsed = max(0.0, now - self.last_refill)
                self.tokens = min(capacity, self.tokens + elapsed * refill_rate)
                self.last_refill = now

            if self.tokens >= requested:
                self.tokens -= requested
                return [1, "0"]
            deficit = requested - self.tokens
            wait_seconds = deficit / max(refill_rate, 0.001)
            return [0, str(wait_seconds)]

        return _run


class FakeClock:
    def __init__(self, initial: float = 100.0) -> None:
        self.now = initial

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.mark.asyncio
async def test_rate_limiter_allows_burst_within_capacity() -> None:
    fake_redis = FakeRedis()
    clock = FakeClock()
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock.advance(seconds)

    limiter = RedisTokenBucketRateLimiter(
        redis_client=fake_redis,  # type: ignore[arg-type]
        rpm_limit=60,
        capacity=3,
        clock=clock,
        sleep_fn=fake_sleep,
    )

    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()
    assert sleeps == []


@pytest.mark.asyncio
async def test_rate_limiter_waits_when_empty_and_refills() -> None:
    fake_redis = FakeRedis()
    clock = FakeClock()
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock.advance(seconds)

    # 60 RPM => 1 token/sec, capacity 2
    limiter = RedisTokenBucketRateLimiter(
        redis_client=fake_redis,  # type: ignore[arg-type]
        rpm_limit=60,
        capacity=2,
        clock=clock,
        sleep_fn=fake_sleep,
    )

    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()  # bucket empty, must sleep ~1.0s

    assert len(sleeps) == 1
    assert sleeps[0] >= 1.0


@pytest.mark.asyncio
async def test_rate_limiter_refill_caps_at_capacity() -> None:
    fake_redis = FakeRedis()
    clock = FakeClock()
    limiter = RedisTokenBucketRateLimiter(
        redis_client=fake_redis,  # type: ignore[arg-type]
        rpm_limit=60,
        capacity=2,
        clock=clock,
    )

    await limiter.acquire()
    clock.advance(1000.0)
    allowed_1, _ = await limiter.try_acquire()
    allowed_2, _ = await limiter.try_acquire()
    allowed_3, wait = await limiter.try_acquire()

    assert allowed_1 is True
    assert allowed_2 is True
    assert allowed_3 is False
    assert wait == pytest.approx(1.0)


def _make_api_status_error(status_code: int, message: str = "error") -> APIStatusError:
    req = httpx.Request("POST", "https://integrate.api.nvidia.com/v1/chat/completions")
    resp = httpx.Response(status_code=status_code, request=req)
    return APIStatusError(message, response=resp, body=None)


@pytest.mark.asyncio
async def test_client_retries_on_429_and_5xx_then_succeeds() -> None:
    settings = Settings(
        llm_api_key="test-key",
        llm_chat_model="test-chat-model",
        embedding_model="test-embed-model",
        llm_max_retries=3,
    )
    limiter = AsyncMock()
    limiter.acquire = AsyncMock(return_value=None)

    sleep_delays: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleep_delays.append(delay)

    success_response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content="hello back", tool_calls=None),
                finish_reason="stop",
            )
        ],
        usage=SimpleNamespace(prompt_tokens=12, completion_tokens=5),
    )

    mock_create = AsyncMock(
        side_effect=[
            _make_api_status_error(429, "rate limited"),
            _make_api_status_error(503, "upstream unavailable"),
            success_response,
        ]
    )
    mock_openai = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=mock_create)),
        embeddings=SimpleNamespace(create=AsyncMock()),
    )

    client = LLMClient(
        settings=settings,
        openai_client=mock_openai,  # type: ignore[arg-type]
        rate_limiter=limiter,
        sleep_fn=fake_sleep,
    )

    result = await client.chat([{"role": "user", "content": "hi"}])

    assert result.content == "hello back"
    assert result.usage.tokens_in == 12
    assert result.usage.tokens_out == 5
    assert result.usage.latency_ms >= 0.0
    assert result.usage.model == "test-chat-model"
    assert mock_create.await_count == 3
    assert limiter.acquire.await_count == 3
    assert len(sleep_delays) == 2


@pytest.mark.asyncio
async def test_client_does_not_retry_on_400() -> None:
    settings = Settings(
        llm_api_key="test-key",
        llm_chat_model="test-chat-model",
        llm_max_retries=3,
    )
    limiter = AsyncMock()
    limiter.acquire = AsyncMock(return_value=None)

    mock_create = AsyncMock(side_effect=_make_api_status_error(400, "bad request"))
    mock_openai = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=mock_create)),
        embeddings=SimpleNamespace(create=AsyncMock()),
    )

    client = LLMClient(
        settings=settings,
        openai_client=mock_openai,  # type: ignore[arg-type]
        rate_limiter=limiter,
    )

    with pytest.raises(APIStatusError):
        await client.chat([{"role": "user", "content": "hi"}])

    assert mock_create.await_count == 1
    assert limiter.acquire.await_count == 1


@pytest.mark.asyncio
async def test_client_stops_after_max_retries() -> None:
    settings = Settings(
        llm_api_key="test-key",
        llm_chat_model="test-chat-model",
        llm_max_retries=2,
    )
    limiter = AsyncMock()
    limiter.acquire = AsyncMock(return_value=None)

    mock_create = AsyncMock(side_effect=_make_api_status_error(502, "bad gateway"))
    mock_openai = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=mock_create)),
        embeddings=SimpleNamespace(create=AsyncMock()),
    )

    client = LLMClient(
        settings=settings,
        openai_client=mock_openai,  # type: ignore[arg-type]
        rate_limiter=limiter,
        sleep_fn=AsyncMock(),
    )

    with pytest.raises(APIStatusError):
        await client.chat([{"role": "user", "content": "hi"}])

    assert mock_create.await_count == 3  # 1 initial + 2 retries
    assert limiter.acquire.await_count == 3


@pytest.mark.asyncio
async def test_client_embed_records_usage_and_order() -> None:
    settings = Settings(
        llm_api_key="test-key",
        embedding_model="nvidia/nemotron-3.5-embed-1b",
    )
    limiter = AsyncMock()
    limiter.acquire = AsyncMock(return_value=None)

    embed_resp = SimpleNamespace(
        data=[
            SimpleNamespace(index=1, embedding=[0.2, 0.3]),
            SimpleNamespace(index=0, embedding=[0.1, 0.4]),
        ],
        usage=SimpleNamespace(prompt_tokens=9),
    )
    mock_embed_create = AsyncMock(return_value=embed_resp)
    mock_openai = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock())),
        embeddings=SimpleNamespace(create=mock_embed_create),
    )

    client = LLMClient(
        settings=settings,
        openai_client=mock_openai,  # type: ignore[arg-type]
        rate_limiter=limiter,
    )

    res = await client.embed(["first", "second"])
    assert res.embeddings == [[0.1, 0.4], [0.2, 0.3]]
    assert res.usage.tokens_in == 9
    assert res.usage.tokens_out == 0
    assert res.usage.latency_ms >= 0.0

