from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.retrieval.config import RetrievalConfig, retrieve_chunks
from app.retrieval.types import RetrievedChunk


def make_chunk(cid: str, source: str = "vector", score: float = 1.0) -> RetrievedChunk:
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
        source=source,
    )


def test_retrieval_config_presets() -> None:
    vec = RetrievalConfig.vector_only(top_k=5)
    assert vec.use_vector is True
    assert vec.use_keyword is False
    assert vec.use_reranker is False
    assert vec.rerank_top_k == 5

    kw = RetrievalConfig.keyword_only(top_k=6)
    assert kw.use_vector is False
    assert kw.use_keyword is True
    assert kw.use_reranker is False
    assert kw.keyword_top_k == 6

    hyb = RetrievalConfig.hybrid_only(vector_top_k=20, keyword_top_k=20, top_k=7)
    assert hyb.use_vector is True
    assert hyb.use_keyword is True
    assert hyb.use_reranker is False
    assert hyb.vector_top_k == 20
    assert hyb.rerank_top_k == 7

    rerank = RetrievalConfig.hybrid_rerank(top_k=8)
    assert rerank.use_vector is True
    assert rerank.use_keyword is True
    assert rerank.use_reranker is True
    assert rerank.rerank_top_k == 8


@pytest.mark.asyncio
async def test_retrieve_chunks_vector_only() -> None:
    chunks = [make_chunk("v1"), make_chunk("v2")]
    cfg = RetrievalConfig.vector_only(top_k=2)

    with patch("app.retrieval.config.vector_search", new_callable=AsyncMock) as mock_vec:
        mock_vec.return_value = chunks
        res = await retrieve_chunks("repo", "query", cfg)

    assert mock_vec.called
    assert len(res) == 2
    assert res[0].chunk_id == "v1"


@pytest.mark.asyncio
async def test_retrieve_chunks_hybrid_rerank() -> None:
    vec_chunks = [make_chunk("v1", "vector")]
    kw_chunks = [make_chunk("k1", "keyword")]
    reranked_chunks = [
        make_chunk("k1", "keyword", score=10.0),
        make_chunk("v1", "vector", score=5.0),
    ]

    cfg = RetrievalConfig.hybrid_rerank(top_k=2)

    with (
        patch("app.retrieval.config.vector_search", new_callable=AsyncMock) as mock_vec,
        patch("app.retrieval.config.keyword_search", new_callable=AsyncMock) as mock_kw,
        patch("app.retrieval.config.rerank_chunks", new_callable=AsyncMock) as mock_rerank,
    ):
        mock_vec.return_value = vec_chunks
        mock_kw.return_value = kw_chunks
        mock_rerank.return_value = reranked_chunks

        res = await retrieve_chunks("repo", "query", cfg)

    assert mock_vec.called
    assert mock_kw.called
    assert mock_rerank.called
    assert len(res) == 2
    assert res[0].chunk_id == "k1"
