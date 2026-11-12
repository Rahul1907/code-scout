import hmac
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent import build_qa_messages, extract_citations, format_sse
from app.config import get_settings
from app.indexing import index_repository
from app.llm import ChatStreamChunk, get_llm_client
from app.retrieval import vector_search


class HealthResponse(BaseModel):
    status: str
    service: str
    timestamp: str


class IndexRequest(BaseModel):
    repoId: str
    cloneUrl: str
    token: str | None = None


class IndexResponse(BaseModel):
    status: str
    repoId: str
    commitSha: str = ""
    stats: dict[str, Any] = {}


class HistoryMessage(BaseModel):
    role: str
    content: str


class AskRequest(BaseModel):
    runId: str
    repoId: str
    conversationHistory: list[HistoryMessage] = Field(default_factory=list)
    question: str


def verify_internal_key(x_internal_key: str | None = Header(default=None)) -> None:
    settings = get_settings()
    if not x_internal_key or not hmac.compare_digest(x_internal_key, settings.internal_api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Key header",
        )


app = FastAPI(title="CodeScout Agent Service", version="0.1.0")


@app.get("/internal/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="agent",
        timestamp=datetime.now(UTC).isoformat(),
    )


@app.post(
    "/internal/index",
    response_model=IndexResponse,
    dependencies=[Depends(verify_internal_key)],
)
async def index_repo(payload: IndexRequest) -> IndexResponse:
    if not ObjectId.is_valid(payload.repoId):
        raise HTTPException(status_code=400, detail="Invalid repoId")

    try:
        result = await index_repository(
            repo_id=payload.repoId,
            clone_url=payload.cloneUrl,
            token=payload.token,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return IndexResponse(
        status=str(result["status"]),
        repoId=payload.repoId,
        commitSha=str(result.get("commitSha", "")),
        stats=dict(result.get("stats", {})),
    )


@app.post(
    "/internal/ask",
    dependencies=[Depends(verify_internal_key)],
)
async def ask_repo(payload: AskRequest) -> StreamingResponse:
    async def event_stream() -> AsyncIterator[str]:
        started = time.perf_counter()
        yield format_sse("run_started", {"runId": payload.runId})

        try:
            chunks = await vector_search(repo_id=payload.repoId, query=payload.question, top_k=8)
            history = [{"role": m.role, "content": m.content} for m in payload.conversationHistory]
            messages = build_qa_messages(
                question=payload.question,
                chunks=chunks,
                conversation_history=history,
            )

            llm = get_llm_client()
            stream = await llm.chat(messages=messages, stream=True)

            accumulated = ""
            emitted_citations: set[tuple[str, int, int]] = set()
            tokens_in = 0
            tokens_out = 0

            assert isinstance(stream, AsyncIterator)
            async for chunk in stream:
                assert isinstance(chunk, ChatStreamChunk)
                if chunk.delta:
                    accumulated += chunk.delta
                    yield format_sse("token", {"text": chunk.delta})

                    for cit in extract_citations(accumulated):
                        key = (cit.filePath, cit.startLine, cit.endLine)
                        if key not in emitted_citations:
                            emitted_citations.add(key)
                            yield format_sse("citation", cit.model_dump())

                if chunk.usage is not None:
                    tokens_in = chunk.usage.tokens_in
                    tokens_out = chunk.usage.tokens_out

            duration_ms = round((time.perf_counter() - started) * 1000.0, 2)
            yield format_sse(
                "run_completed",
                {
                    "runId": payload.runId,
                    "totals": {
                        "tokensIn": tokens_in,
                        "tokensOut": tokens_out,
                        "llmCalls": 1,
                        "durationMs": duration_ms,
                    },
                },
            )
        except Exception as exc:
            yield format_sse(
                "error",
                {
                    "message": str(exc),
                    "retryable": False,
                },
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
