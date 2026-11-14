import asyncio
import hmac
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent import build_qa_messages, extract_citations, format_sse, run_agent_loop
from app.config import get_settings
from app.db import get_db, get_redis_client
from app.indexing import index_repository
from app.llm import ChatStreamChunk, get_llm_client
from app.retrieval import RetrievalConfig, retrieve_chunks
from app.tracing import start_question_trace


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
    retrievalConfig: RetrievalConfig | None = None


class RunRequest(BaseModel):
    runId: str
    repoId: str
    conversationId: str | None = None
    userId: str | None = None
    conversationHistory: list[HistoryMessage] = Field(default_factory=list)
    instruction: str
    mode: str = "ask"


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
        settings = get_settings()
        trace = start_question_trace(
            run_id=payload.runId,
            repo_id=payload.repoId,
            question=payload.question,
        )
        yield format_sse("run_started", {"runId": payload.runId})

        accumulated = ""
        emitted_citation_objs: list[dict[str, Any]] = []
        tokens_in = 0
        tokens_out = 0
        error_message: str | None = None

        try:
            retrieval_cfg = payload.retrievalConfig or RetrievalConfig()
            ret_started = time.perf_counter()
            ret_span = trace.start_retrieval(
                query=payload.question,
                top_k=retrieval_cfg.rerank_top_k,
            )
            try:
                chunks = await retrieve_chunks(
                    repo_id=payload.repoId,
                    query=payload.question,
                    config=retrieval_cfg,
                )
            except Exception as ret_exc:
                trace.end_retrieval(
                    ret_span,
                    chunks=[],
                    latency_ms=(time.perf_counter() - ret_started) * 1000.0,
                    error=str(ret_exc),
                )
                raise

            trace.end_retrieval(
                ret_span,
                chunks=[
                    {
                        "filePath": c.file_path,
                        "startLine": c.start_line,
                        "endLine": c.end_line,
                        "score": round(c.score, 4),
                        "source": c.source,
                    }
                    for c in chunks
                ],
                latency_ms=(time.perf_counter() - ret_started) * 1000.0,
            )

            retrieved_chunk_payloads = [
                {
                    "chunkId": c.chunk_id,
                    "filePath": c.file_path,
                    "startLine": c.start_line,
                    "endLine": c.end_line,
                    "score": round(c.score, 4),
                    "source": c.source,
                    "symbolName": c.symbol_name,
                    "content": c.content,
                }
                for c in chunks
            ]
            yield format_sse("retrieval_debug", {"chunks": retrieved_chunk_payloads})

            history = [{"role": m.role, "content": m.content} for m in payload.conversationHistory]
            messages = build_qa_messages(
                question=payload.question,
                chunks=chunks,
                conversation_history=history,
            )

            llm_started = time.perf_counter()
            gen_span = trace.start_generation(
                model=settings.llm_chat_model,
                message_count=len(messages),
            )

            try:
                llm = get_llm_client()
                stream = await llm.chat(messages=messages, stream=True)

                emitted_citations: set[tuple[str, int, int]] = set()
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
                                cit_dict = cit.model_dump()
                                emitted_citation_objs.append(cit_dict)
                                yield format_sse("citation", cit_dict)

                    if chunk.usage is not None:
                        tokens_in = chunk.usage.tokens_in
                        tokens_out = chunk.usage.tokens_out
            except Exception as llm_exc:
                trace.end_generation(
                    gen_span,
                    output_text=accumulated,
                    tokens_in=tokens_in,
                    tokens_out=tokens_out,
                    latency_ms=(time.perf_counter() - llm_started) * 1000.0,
                    error=str(llm_exc),
                )
                raise

            trace.end_generation(
                gen_span,
                output_text=accumulated,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                latency_ms=(time.perf_counter() - llm_started) * 1000.0,
            )

            duration_ms = round((time.perf_counter() - started) * 1000.0, 2)
            yield format_sse(
                "run_completed",
                {
                    "runId": payload.runId,
                    "langfuseTraceId": trace.trace_id,
                    "totals": {
                        "tokensIn": tokens_in,
                        "tokensOut": tokens_out,
                        "llmCalls": 1,
                        "durationMs": duration_ms,
                    },
                },
            )
        except Exception as exc:
            error_message = str(exc)
            yield format_sse(
                "error",
                {
                    "message": error_message,
                    "retryable": False,
                },
            )
        finally:
            await asyncio.to_thread(
                trace.finish,
                output_text=accumulated,
                citations=emitted_citation_objs,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                error=error_message,
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


@app.post(
    "/internal/run",
    dependencies=[Depends(verify_internal_key)],
)
async def run_agent(payload: RunRequest) -> StreamingResponse:
    if not ObjectId.is_valid(payload.repoId):
        raise HTTPException(status_code=400, detail="Invalid repoId")

    history = [{"role": m.role, "content": m.content} for m in payload.conversationHistory]
    return StreamingResponse(
        run_agent_loop(
            run_id=payload.runId,
            repo_id=payload.repoId,
            instruction=payload.instruction,
            conversation_id=payload.conversationId,
            user_id=payload.userId,
            conversation_history=history,
            mode=payload.mode,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post(
    "/internal/runs/{run_id}/cancel",
    dependencies=[Depends(verify_internal_key)],
)
async def cancel_run(run_id: str) -> dict[str, Any]:
    redis_client = get_redis_client()
    try:
        await redis_client.set(f"run_cancelled:{run_id}", "1", ex=3600)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to cancel in Redis: {exc}") from exc

    db = get_db()
    await asyncio.to_thread(
        db["agent_runs"].update_one,
        {"runId": run_id},
        {"$set": {"status": "cancelled", "completedAt": datetime.now(UTC)}},
    )
    return {"status": "cancelled", "runId": run_id}
