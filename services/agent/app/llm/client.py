import asyncio
import json
import logging
import random
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from functools import lru_cache
from typing import Any, Literal

import httpx
import redis.asyncio as redis_async
from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.llm.rate_limiter import RedisTokenBucketRateLimiter

logger = logging.getLogger("codescout.llm")


class LLMUsage(BaseModel):
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: float = 0.0
    model: str = ""


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: str


class ChatResponse(BaseModel):
    content: str
    tool_calls: list[ToolCall] = Field(default_factory=list)
    finish_reason: str | None = None
    usage: LLMUsage


class ChatStreamChunk(BaseModel):
    delta: str = ""
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    finish_reason: str | None = None
    usage: LLMUsage | None = None


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    usage: LLMUsage


class RerankItem(BaseModel):
    index: int
    score: float
    document: str


class RerankResponse(BaseModel):
    results: list[RerankItem]
    usage: LLMUsage


def _is_retryable_exception(exc: Exception) -> bool:
    if isinstance(
        exc,
        (APIConnectionError, APITimeoutError, httpx.TransportError, httpx.TimeoutException),
    ):
        return True
    if isinstance(exc, APIStatusError):
        return exc.status_code == 429 or exc.status_code >= 500
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code == 429 or exc.response.status_code >= 500
    return False


def _compute_backoff_seconds(
    attempt: int,
    base_delay: float = 0.5,
    max_delay: float = 30.0,
) -> float:
    exp = min(max_delay, base_delay * (2**attempt))
    return random.uniform(exp * 0.5, exp)


def _derive_rerank_url(model: str, configured_url: str) -> str:
    if configured_url:
        return configured_url
    # NVIDIA NIM rerank models use ai.api.nvidia.com/v1/retrieval/{org}/{slug}/reranking
    slug = model.replace(".", "-")
    return f"https://ai.api.nvidia.com/v1/retrieval/{slug}/reranking"


class LLMClient:
    """Provider abstraction around OpenAI-compatible chat/embed APIs and NVIDIA rerank."""

    def __init__(
        self,
        settings: Settings,
        openai_client: AsyncOpenAI | None = None,
        rate_limiter: RedisTokenBucketRateLimiter | None = None,
        http_client: httpx.AsyncClient | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._settings = settings
        self._sleep = sleep_fn
        self._openai = openai_client or AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            max_retries=0,
        )
        if rate_limiter is not None:
            self._rate_limiter = rate_limiter
        else:
            redis_client = redis_async.from_url(settings.redis_url, decode_responses=True)
            self._rate_limiter = RedisTokenBucketRateLimiter(
                redis_client=redis_client,
                rpm_limit=settings.llm_rpm_limit,
            )
        self._http_client = http_client

    async def _execute_with_retry[T](self, operation: str, fn: Callable[[], Awaitable[T]]) -> T:
        max_retries = max(0, self._settings.llm_max_retries)
        last_exc: Exception | None = None
        for attempt in range(max_retries + 1):
            await self._rate_limiter.acquire(tokens=1)
            try:
                return await fn()
            except Exception as exc:
                last_exc = exc
                if attempt >= max_retries or not _is_retryable_exception(exc):
                    raise
                delay = _compute_backoff_seconds(attempt)
                logger.warning(
                    json.dumps(
                        {
                            "event": "llm_retry",
                            "operation": operation,
                            "attempt": attempt + 1,
                            "max_retries": max_retries,
                            "delay_seconds": round(delay, 3),
                            "error": str(exc),
                        }
                    )
                )
                await self._sleep(delay)
        assert last_exc is not None
        raise last_exc

    def _log_usage(self, operation: str, usage: LLMUsage) -> None:
        logger.info(
            json.dumps(
                {
                    "event": "llm_call",
                    "operation": operation,
                    "model": usage.model,
                    "tokens_in": usage.tokens_in,
                    "tokens_out": usage.tokens_out,
                    "latency_ms": round(usage.latency_ms, 2),
                }
            )
        )

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        model: str | None = None,
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> ChatResponse | AsyncIterator[ChatStreamChunk]:
        chosen_model = model or self._settings.llm_chat_model
        if not chosen_model:
            raise ValueError("LLM model is not configured (set LLM_CHAT_MODEL or pass model=)")

        kwargs: dict[str, Any] = {
            "model": chosen_model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
        }
        if tools:
            kwargs["tools"] = tools
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens

        if stream:
            kwargs["stream_options"] = {"include_usage": True}
            return self._stream_chat(chosen_model, kwargs)

        start = time.perf_counter()
        raw = await self._execute_with_retry(
            "chat",
            lambda: self._openai.chat.completions.create(**kwargs),
        )
        latency_ms = (time.perf_counter() - start) * 1000.0

        choice = raw.choices[0]
        message = choice.message
        parsed_tool_calls: list[ToolCall] = []
        if message.tool_calls:
            for tc in message.tool_calls:
                parsed_tool_calls.append(
                    ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        arguments=tc.function.arguments or "",
                    )
                )

        tokens_in = int(getattr(raw.usage, "prompt_tokens", 0) or 0) if raw.usage else 0
        tokens_out = int(getattr(raw.usage, "completion_tokens", 0) or 0) if raw.usage else 0
        usage = LLMUsage(
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            model=chosen_model,
        )
        self._log_usage("chat", usage)
        return ChatResponse(
            content=message.content or "",
            tool_calls=parsed_tool_calls,
            finish_reason=choice.finish_reason,
            usage=usage,
        )

    async def _stream_chat(
        self,
        chosen_model: str,
        kwargs: dict[str, Any],
    ) -> AsyncIterator[ChatStreamChunk]:
        start = time.perf_counter()
        stream_obj = await self._execute_with_retry(
            "chat_stream",
            lambda: self._openai.chat.completions.create(**kwargs),
        )

        tokens_in = 0
        tokens_out = 0
        async for chunk in stream_obj:
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                tokens_in = int(getattr(chunk_usage, "prompt_tokens", 0) or tokens_in)
                tokens_out = int(getattr(chunk_usage, "completion_tokens", 0) or tokens_out)

            if not getattr(chunk, "choices", None):
                continue

            choice = chunk.choices[0]
            delta_obj = choice.delta
            delta_text = getattr(delta_obj, "content", None) or ""
            delta_tool_calls: list[dict[str, Any]] = []
            raw_tcs = getattr(delta_obj, "tool_calls", None)
            if raw_tcs:
                for tc in raw_tcs:
                    delta_tool_calls.append(
                        {
                            "index": tc.index,
                            "id": tc.id,
                            "name": tc.function.name if tc.function else None,
                            "arguments": tc.function.arguments if tc.function else None,
                        }
                    )

            yield ChatStreamChunk(
                delta=delta_text,
                tool_calls=delta_tool_calls,
                finish_reason=choice.finish_reason,
            )

        latency_ms = (time.perf_counter() - start) * 1000.0
        usage = LLMUsage(
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            model=chosen_model,
        )
        self._log_usage("chat_stream", usage)
        yield ChatStreamChunk(usage=usage)

    async def embed(
        self,
        texts: list[str],
        model: str | None = None,
        input_type: Literal["passage", "query"] = "passage",
    ) -> EmbedResponse:
        if not texts:
            return EmbedResponse(
                embeddings=[],
                usage=LLMUsage(model=model or self._settings.embedding_model),
            )

        chosen_model = model or self._settings.embedding_model
        if not chosen_model:
            raise ValueError(
                "Embedding model is not configured (set EMBEDDING_MODEL or pass model=)"
            )

        extra_body: dict[str, Any] = {}
        if "nvidia" in self._settings.llm_base_url or chosen_model.startswith("nvidia/"):
            extra_body = {"input_type": input_type, "truncate": "END"}

        start = time.perf_counter()
        raw = await self._execute_with_retry(
            "embed",
            lambda: self._openai.embeddings.create(
                model=chosen_model,
                input=texts,
                extra_body=extra_body or None,
            ),
        )
        latency_ms = (time.perf_counter() - start) * 1000.0

        ordered = sorted(raw.data, key=lambda item: item.index)
        vectors = [list(item.embedding) for item in ordered]
        tokens_in = int(getattr(raw.usage, "prompt_tokens", 0) or 0) if raw.usage else 0
        usage = LLMUsage(
            tokens_in=tokens_in,
            tokens_out=0,
            latency_ms=latency_ms,
            model=chosen_model,
        )
        self._log_usage("embed", usage)
        return EmbedResponse(embeddings=vectors, usage=usage)

    async def rerank(
        self,
        query: str,
        documents: list[str],
        model: str | None = None,
        top_n: int | None = None,
    ) -> RerankResponse:
        if not documents:
            return RerankResponse(
                results=[],
                usage=LLMUsage(model=model or self._settings.rerank_model),
            )

        chosen_model = model or self._settings.rerank_model
        if not chosen_model:
            raise ValueError("Rerank model is not configured (set RERANK_MODEL or pass model=)")

        url = _derive_rerank_url(chosen_model, self._settings.rerank_base_url)
        payload = {
            "model": chosen_model,
            "query": {"text": query},
            "passages": [{"text": doc} for doc in documents],
        }
        headers = {
            "Authorization": f"Bearer {self._settings.llm_api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        async def _post() -> dict[str, Any]:
            if self._http_client is not None:
                resp = await self._http_client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                return dict(resp.json())
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                return dict(resp.json())

        start = time.perf_counter()
        data = await self._execute_with_retry("rerank", _post)
        latency_ms = (time.perf_counter() - start) * 1000.0

        rankings = data.get("rankings", [])
        items: list[RerankItem] = []
        for entry in rankings:
            idx = int(entry["index"])
            if 0 <= idx < len(documents):
                items.append(
                    RerankItem(
                        index=idx,
                        score=float(entry.get("logit", entry.get("score", 0.0))),
                        document=documents[idx],
                    )
                )
        items.sort(key=lambda item: item.score, reverse=True)
        if top_n is not None:
            items = items[:top_n]

        usage_raw = data.get("usage") or {}
        tokens_in = int(usage_raw.get("prompt_tokens", 0) or 0)
        tokens_out = int(usage_raw.get("completion_tokens", 0) or 0)
        usage = LLMUsage(
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_ms=latency_ms,
            model=chosen_model,
        )
        self._log_usage("rerank", usage)
        return RerankResponse(results=items, usage=usage)


@lru_cache
def get_llm_client() -> LLMClient:
    return LLMClient(settings=get_settings())


async def chat(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    stream: bool = False,
    model: str | None = None,
) -> ChatResponse | AsyncIterator[ChatStreamChunk]:
    return await get_llm_client().chat(messages=messages, tools=tools, stream=stream, model=model)


async def embed(
    texts: list[str],
    model: str | None = None,
    input_type: Literal["passage", "query"] = "passage",
) -> EmbedResponse:
    return await get_llm_client().embed(texts=texts, model=model, input_type=input_type)


async def rerank(
    query: str,
    documents: list[str],
    model: str | None = None,
    top_n: int | None = None,
) -> RerankResponse:
    return await get_llm_client().rerank(
        query=query,
        documents=documents,
        model=model,
        top_n=top_n,
    )

