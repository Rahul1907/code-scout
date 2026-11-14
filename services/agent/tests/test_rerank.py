from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.llm.client import LLMUsage, RerankItem, RerankResponse
from app.retrieval.rerank import rerank_chunks
from app.retrieval.types import RetrievedChunk


def make_chunk(cid: str, score: float = 1.0) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=cid,
        repo_id="test-repo",
        file_path=f"path/{cid}.py",
        language="python",
        symbol_name=f"sym_{cid}",
        symbol_type="function",
        start_line=1,
        end_line=20,
        content=f"# content {cid}",
        score=score,
        source="fused",
    )


@pytest.mark.asyncio
async def test_rerank_chunks_reorders_by_score() -> None:
    chunks = [make_chunk("A", 1.0), make_chunk("B", 0.8), make_chunk("C", 0.6)]

    mock_response = RerankResponse(
        results=[
            RerankItem(index=1, score=12.5, document="docB"),  # B ranked 1st
            RerankItem(index=0, score=4.2, document="docA"),   # A ranked 2nd
        ],
        usage=LLMUsage(model="test-reranker", tokens_in=50),
    )

    mock_llm = AsyncMock()
    mock_llm.rerank.return_value = mock_response

    with patch("app.retrieval.rerank.get_llm_client", return_value=mock_llm):
        reranked = await rerank_chunks("query", chunks, top_k=2)

    assert len(reranked) == 2
    assert reranked[0].chunk_id == "B"
    assert reranked[0].score == pytest.approx(12.5)
    assert reranked[1].chunk_id == "A"
    assert reranked[1].score == pytest.approx(4.2)


@pytest.mark.asyncio
async def test_rerank_chunks_falls_back_on_error() -> None:
    chunks = [make_chunk("A", 1.0), make_chunk("B", 0.8), make_chunk("C", 0.6)]

    mock_llm = AsyncMock()
    mock_llm.rerank.side_effect = RuntimeError("Rate limit 429")

    with patch("app.retrieval.rerank.get_llm_client", return_value=mock_llm):
        result = await rerank_chunks("query", chunks, top_k=2)

    # Should fall back to fused order truncated to top_k
    assert len(result) == 2
    assert result[0].chunk_id == "A"
    assert result[1].chunk_id == "B"


@pytest.mark.asyncio
async def test_rerank_chunks_empty() -> None:
    assert await rerank_chunks("query", []) == []

