from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from app.tracing.langfuse import QuestionTrace


class FakeSpan:
    def __init__(self, name: str, kwargs: dict[str, Any]) -> None:
        self.name = name
        self.kwargs = kwargs
        self.updates: list[dict[str, Any]] = []
        self.ended = False
        self.children: list[FakeSpan] = []

    def start_observation(self, *, name: str, **kwargs: Any) -> FakeSpan:
        child = FakeSpan(name, kwargs)
        self.children.append(child)
        return child

    def update(self, **kwargs: Any) -> None:
        self.updates.append(kwargs)

    def end(self) -> None:
        self.ended = True


def test_question_trace_records_retrieval_and_generation_spans() -> None:
    fake_client = MagicMock()
    fake_client.create_trace_id.return_value = "a" * 32
    root_span = FakeSpan("qa_question", {})
    fake_client.start_observation.return_value = root_span

    trace = QuestionTrace(
        client=fake_client,
        run_id="run-123",
        repo_id="repo-abc",
        question="Where is routing handled?",
    )

    ret_span = trace.start_retrieval(query="Where is routing handled?", top_k=8)
    trace.end_retrieval(
        ret_span,
        chunks=[{"filePath": "app.py", "startLine": 1, "endLine": 10, "score": 0.9}],
        latency_ms=42.5,
    )

    gen_span = trace.start_generation(model="test-model", message_count=2)
    trace.end_generation(
        gen_span,
        output_text="Routing is in [app.py:1-10]",
        tokens_in=120,
        tokens_out=35,
        latency_ms=410.2,
    )

    trace.finish(
        output_text="Routing is in [app.py:1-10]",
        citations=[{"filePath": "app.py", "startLine": 1, "endLine": 10}],
        tokens_in=120,
        tokens_out=35,
    )

    assert trace.trace_id == "a" * 32
    assert len(root_span.children) == 2

    retrieval_child, gen_child = root_span.children
    assert retrieval_child.name == "vector_retrieval"
    assert retrieval_child.ended is True
    assert retrieval_child.updates[0]["metadata"]["latencyMs"] == pytest.approx(42.5)

    assert gen_child.name == "llm_answer"
    assert gen_child.kwargs["model"] == "test-model"
    assert gen_child.ended is True
    assert gen_child.updates[0]["usage_details"] == {"input": 120, "output": 35}
    assert gen_child.updates[0]["metadata"]["latencyMs"] == pytest.approx(410.2)

    assert root_span.ended is True
    fake_client.flush.assert_called_once()


def test_question_trace_noop_without_langfuse_client() -> None:
    trace = QuestionTrace(
        client=None,
        run_id="run-noop",
        repo_id="repo-abc",
        question="Test",
    )
    ret = trace.start_retrieval(query="Test", top_k=8)
    trace.end_retrieval(ret, chunks=[], latency_ms=1.0)
    gen = trace.start_generation(model="m", message_count=1)
    trace.end_generation(gen, output_text="", tokens_in=0, tokens_out=0, latency_ms=1.0)
    trace.finish()

    assert trace.trace_id is None
    assert ret is None
    assert gen is None

