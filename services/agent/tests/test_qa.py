from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.agent import build_qa_messages, extract_citations
from app.config import get_settings
from app.llm import ChatStreamChunk, LLMUsage
from app.main import app
from app.retrieval import RetrievedChunk


def test_extract_citations_deduplicates_and_parses_ranges() -> None:
    text = (
        "Routing is defined in [src/routes/auth.ts:15-42] and also "
        "[src/routes/auth.ts:15-42] and [app/main.py:10]."
    )
    citations = extract_citations(text)
    assert len(citations) == 2
    assert citations[0].model_dump() == {
        "filePath": "src/routes/auth.ts",
        "startLine": 15,
        "endLine": 42,
    }
    assert citations[1].model_dump() == {
        "filePath": "app/main.py",
        "startLine": 10,
        "endLine": 10,
    }


def test_build_qa_messages_includes_grounding_and_chunks() -> None:
    chunk = RetrievedChunk(
        chunk_id="c1",
        repo_id="r1",
        file_path="starlette/routing.py",
        language="python",
        symbol_name="Router",
        symbol_type="class",
        start_line=100,
        end_line=140,
        content="class Router:\n    pass",
        score=0.95,
    )
    msgs = build_qa_messages("Where is routing handled?", [chunk])
    assert msgs[0]["role"] == "system"
    assert "not found in the indexed code" in msgs[0]["content"]
    assert "[starlette/routing.py:100-140]" in msgs[-1]["content"]


def test_internal_ask_streams_sse_events() -> None:
    settings = get_settings()

    async def fake_stream() -> AsyncIterator[ChatStreamChunk]:
        yield ChatStreamChunk(delta="Routing is handled in ")
        yield ChatStreamChunk(delta="[starlette/routing.py:100-140].")
        yield ChatStreamChunk(usage=LLMUsage(tokens_in=50, tokens_out=12, latency_ms=100.0))

    mock_llm = AsyncMock()
    mock_llm.chat = AsyncMock(return_value=fake_stream())

    fake_chunks = [
        RetrievedChunk(
            chunk_id="c1",
            repo_id="r1",
            file_path="starlette/routing.py",
            language="python",
            symbol_name="Router",
            symbol_type="class",
            start_line=100,
            end_line=140,
            content="class Router:\n    pass",
            score=0.95,
        )
    ]

    with (
        patch("app.main.vector_search", AsyncMock(return_value=fake_chunks)),
        patch("app.main.get_llm_client", return_value=mock_llm),
    ):
        client = TestClient(app)
        res = client.post(
            "/internal/ask",
            headers={"X-Internal-Key": settings.internal_api_key},
            json={
                "runId": "run-1",
                "repoId": "r1",
                "conversationHistory": [],
                "question": "Where is routing handled?",
            },
        )

    assert res.status_code == 200
    body = res.text
    assert "event: run_started" in body
    assert "event: token" in body
    assert "event: citation" in body
    assert '"filePath": "starlette/routing.py"' in body
    assert "event: run_completed" in body

