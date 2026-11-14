from __future__ import annotations

import logging
import time
from functools import lru_cache
from typing import Any

from langfuse import Langfuse

from app.config import get_settings

logger = logging.getLogger(__name__)


@lru_cache
def get_langfuse_client() -> Langfuse | None:
    settings = get_settings()
    if not settings.langfuse_public_key or not settings.langfuse_secret_key:
        return None
    return Langfuse(
        public_key=settings.langfuse_public_key,
        secret_key=settings.langfuse_secret_key,
        host=settings.langfuse_host,
    )


class QuestionTrace:
    """Manages a per-question Langfuse trace with explicit child spans across async streams."""

    def __init__(
        self,
        client: Langfuse | None,
        run_id: str,
        repo_id: str,
        question: str,
    ) -> None:
        self._client = client
        self.trace_id: str | None = None
        self._root: Any = None
        self._started = time.perf_counter()

        if self._client is None:
            return

        try:
            self.trace_id = self._client.create_trace_id(seed=run_id)
            self._root = self._client.start_observation(
                trace_context={"trace_id": self.trace_id},
                name="qa_question",
                as_type="agent",
                input={"question": question, "repoId": repo_id},
                metadata={"runId": run_id, "repoId": repo_id},
            )
        except Exception as exc:
            logger.warning("Failed to start Langfuse trace: %s", exc)
            self._root = None

    def start_retrieval(self, query: str, top_k: int) -> Any:
        if self._root is None:
            return None
        try:
            return self._root.start_observation(
                name="vector_retrieval",
                as_type="retriever",
                input={"query": query, "topK": top_k},
            )
        except Exception as exc:
            logger.warning("Failed to start Langfuse retrieval span: %s", exc)
            return None

    def end_retrieval(
        self,
        span: Any,
        *,
        chunks: list[dict[str, Any]],
        latency_ms: float,
        error: str | None = None,
    ) -> None:
        if span is None:
            return
        try:
            kwargs: dict[str, Any] = {
                "output": {"chunkCount": len(chunks), "chunks": chunks},
                "metadata": {"latencyMs": round(latency_ms, 2)},
            }
            if error:
                kwargs["level"] = "ERROR"
                kwargs["status_message"] = error
            span.update(**kwargs)
            span.end()
        except Exception as exc:
            logger.warning("Failed to finish Langfuse retrieval span: %s", exc)

    def start_generation(self, *, model: str, message_count: int) -> Any:
        if self._root is None:
            return None
        try:
            return self._root.start_observation(
                name="llm_answer",
                as_type="generation",
                model=model,
                input={"messageCount": message_count},
            )
        except Exception as exc:
            logger.warning("Failed to start Langfuse generation span: %s", exc)
            return None

    def end_generation(
        self,
        generation: Any,
        *,
        output_text: str,
        tokens_in: int,
        tokens_out: int,
        latency_ms: float,
        error: str | None = None,
    ) -> None:
        if generation is None:
            return
        try:
            kwargs: dict[str, Any] = {
                "output": output_text,
                "usage_details": {"input": tokens_in, "output": tokens_out},
                "metadata": {"latencyMs": round(latency_ms, 2)},
            }
            if error:
                kwargs["level"] = "ERROR"
                kwargs["status_message"] = error
            generation.update(**kwargs)
            generation.end()
        except Exception as exc:
            logger.warning("Failed to finish Langfuse generation span: %s", exc)

    def finish(
        self,
        *,
        output_text: str = "",
        citations: list[dict[str, Any]] | None = None,
        tokens_in: int = 0,
        tokens_out: int = 0,
        error: str | None = None,
    ) -> None:
        total_ms = round((time.perf_counter() - self._started) * 1000.0, 2)
        if self._root is not None:
            try:
                kwargs: dict[str, Any] = {
                    "output": {
                        "answer": output_text,
                        "citations": citations or [],
                    },
                    "metadata": {
                        "durationMs": total_ms,
                        "tokensIn": tokens_in,
                        "tokensOut": tokens_out,
                    },
                }
                if error:
                    kwargs["level"] = "ERROR"
                    kwargs["status_message"] = error
                self._root.update(**kwargs)
                self._root.end()
            except Exception as exc:
                logger.warning("Failed to close Langfuse root trace: %s", exc)

        if self._client is not None:
            try:
                self._client.flush()
            except Exception as exc:
                logger.warning("Failed to flush Langfuse client: %s", exc)


def start_question_trace(*, run_id: str, repo_id: str, question: str) -> QuestionTrace:
    return QuestionTrace(
        client=get_langfuse_client(),
        run_id=run_id,
        repo_id=repo_id,
        question=question,
    )


class AgentRunTrace:
    """Manages a Langfuse trace for multi-step agent runs with a span per step."""

    def __init__(
        self,
        client: Langfuse | None,
        run_id: str,
        repo_id: str,
        instruction: str,
        mode: str = "ask",
    ) -> None:
        self._client = client
        self.trace_id: str | None = None
        self._root: Any = None
        self._started = time.perf_counter()

        if self._client is None:
            return

        try:
            self.trace_id = self._client.create_trace_id(seed=run_id)
            self._root = self._client.start_observation(
                trace_context={"trace_id": self.trace_id},
                name=f"agent_run_{mode}",
                as_type="agent",
                input={"instruction": instruction, "repoId": repo_id, "mode": mode},
                metadata={"runId": run_id, "repoId": repo_id, "mode": mode},
            )
        except Exception as exc:
            logger.warning("Failed to start Langfuse agent trace: %s", exc)
            self._root = None

    def start_step_span(
        self,
        step_index: int,
        step_type: str,
        tool_name: str | None,
        input_data: Any,
    ) -> Any:
        if self._root is None:
            return None
        try:
            span_name = f"step_{step_index}_{tool_name or step_type}"
            as_type = "tool" if tool_name else "generation"
            return self._root.start_observation(
                name=span_name,
                as_type=as_type,
                input={
                    "stepIndex": step_index,
                    "type": step_type,
                    "tool": tool_name,
                    "input": input_data,
                },
                metadata={"stepIndex": step_index, "tool": tool_name},
            )
        except Exception as exc:
            logger.warning("Failed to start step span: %s", exc)
            return None

    def end_step_span(
        self,
        span: Any,
        *,
        output_summary: str,
        latency_ms: float,
        tokens_in: int = 0,
        tokens_out: int = 0,
        error: str | None = None,
    ) -> None:
        if span is None:
            return
        try:
            kwargs: dict[str, Any] = {
                "output": output_summary,
                "metadata": {"latencyMs": round(latency_ms, 2)},
            }
            if tokens_in or tokens_out:
                kwargs["usage_details"] = {"input": tokens_in, "output": tokens_out}
            if error:
                kwargs["level"] = "ERROR"
                kwargs["status_message"] = error
            span.update(**kwargs)
            span.end()
        except Exception as exc:
            logger.warning("Failed to finish step span: %s", exc)

    def finish(
        self,
        *,
        status: str,
        final_answer: str = "",
        totals: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        total_ms = round((time.perf_counter() - self._started) * 1000.0, 2)
        if self._root is not None:
            try:
                kwargs: dict[str, Any] = {
                    "output": {
                        "status": status,
                        "answer": final_answer,
                        "totals": totals or {},
                    },
                    "metadata": {
                        "durationMs": total_ms,
                        "status": status,
                        **(totals or {}),
                    },
                }
                if error:
                    kwargs["level"] = "ERROR"
                    kwargs["status_message"] = error
                self._root.update(**kwargs)
                self._root.end()
            except Exception as exc:
                logger.warning("Failed to close Langfuse agent root trace: %s", exc)

        if self._client is not None:
            try:
                self._client.flush()
            except Exception as exc:
                logger.warning("Failed to flush Langfuse client: %s", exc)


def start_agent_trace(
    *,
    run_id: str,
    repo_id: str,
    instruction: str,
    mode: str = "ask",
) -> AgentRunTrace:
    return AgentRunTrace(
        client=get_langfuse_client(),
        run_id=run_id,
        repo_id=repo_id,
        instruction=instruction,
        mode=mode,
    )

