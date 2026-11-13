from __future__ import annotations

from unittest.mock import patch

import pytest

from app.retrieval.fusion import hybrid_search, reciprocal_rank_fusion
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


def test_reciprocal_rank_fusion_scoring_and_deduplication() -> None:
    # List 1 (vector): A, B, C
    list1 = [
        make_chunk("A", source="vector"),
        make_chunk("B", source="vector"),
        make_chunk("C", source="vector"),
    ]
    # List 2 (keyword): B, D, A
    list2 = [
        make_chunk("B", source="keyword"),
        make_chunk("D", source="keyword"),
        make_chunk("A", source="keyword"),
    ]

    fused = reciprocal_rank_fusion([list1, list2], k=60, top_k=10)

    # All unique chunks should be present: A, B, C, D
    chunk_ids = [c.chunk_id for c in fused]
    assert set(chunk_ids) == {"A", "B", "C", "D"}

    # B was rank 2 in list1 and rank 1 in list2:
    # 1/(60+2) + 1/(60+1) = 1/62 + 1/61 = 0.016129 + 0.016393 = 0.032522
    # A was rank 1 in list1 and rank 3 in list2:
    # 1/(60+1) + 1/(60+3) = 1/61 + 1/63 = 0.016393 + 0.015873 = 0.032266
    # So B should rank 1st, then A
    assert fused[0].chunk_id == "B"
    assert fused[0].source == "both"
    assert fused[1].chunk_id == "A"
    assert fused[1].source == "both"

    # C and D are single-source
    c_chunk = next(c for c in fused if c.chunk_id == "C")
    d_chunk = next(c for c in fused if c.chunk_id == "D")
    assert c_chunk.source == "vector"
    assert d_chunk.source == "keyword"


def test_reciprocal_rank_fusion_top_k() -> None:
    list1 = [make_chunk(f"c{i}") for i in range(10)]
    fused = reciprocal_rank_fusion([list1], k=60, top_k=5)
    assert len(fused) == 5
    assert fused[0].chunk_id == "c0"


def test_reciprocal_rank_fusion_empty_lists() -> None:
    assert reciprocal_rank_fusion([], k=60) == []
    assert reciprocal_rank_fusion([[], []], k=60) == []


@pytest.mark.asyncio
async def test_hybrid_search_runs_concurrently() -> None:
    mock_vec = [make_chunk("vec-1", source="vector")]
    mock_kw = [make_chunk("kw-1", source="keyword")]

    with (
        patch("app.retrieval.fusion.vector_search", return_value=mock_vec) as p_vec,
        patch("app.retrieval.fusion.keyword_search", return_value=mock_kw) as p_kw,
    ):
        results = await hybrid_search(repo_id="test-repo", query="my query", top_k=5)

    assert p_vec.called
    assert p_kw.called
    assert len(results) == 2
    assert {r.chunk_id for r in results} == {"vec-1", "kw-1"}
