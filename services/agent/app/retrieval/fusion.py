from __future__ import annotations

import asyncio
import logging

from app.retrieval.keyword import keyword_search
from app.retrieval.types import RetrievedChunk
from app.retrieval.vector import vector_search

logger = logging.getLogger(__name__)


def reciprocal_rank_fusion(
    ranked_lists: list[list[RetrievedChunk]],
    k: int = 60,
    top_k: int = 30,
) -> list[RetrievedChunk]:
    """Combine multiple ranked chunk lists using Reciprocal Rank Fusion (RRF).

    Formula:
      RRF_score(chunk) = SUM_m [ 1 / (k + rank_m(chunk)) ]
    where rank_m is 1-based.
    Deduplicates by chunk_id, combines sources ("vector", "keyword", or "both"),
    and sorts descending by RRF score.
    """
    scores: dict[str, float] = {}
    chunk_map: dict[str, RetrievedChunk] = {}
    sources_map: dict[str, set[str]] = {}

    for ranked_list in ranked_lists:
        for rank, chunk in enumerate(ranked_list, start=1):
            cid = chunk.chunk_id
            if cid not in chunk_map:
                chunk_map[cid] = chunk
                sources_map[cid] = set()

            raw_src = chunk.source if chunk.source != "unknown" else "vector"
            sources_map[cid].add(raw_src)
            scores[cid] = scores.get(cid, 0.0) + (1.0 / (k + rank))

    fused: list[RetrievedChunk] = []
    for cid, rrf_score in scores.items():
        base_chunk = chunk_map[cid]
        src_set = sources_map[cid]
        if len(src_set) > 1 or "both" in src_set:
            source_label = "both"
        elif "keyword" in src_set:
            source_label = "keyword"
        else:
            source_label = "vector"

        fused.append(
            base_chunk.model_copy(
                update={
                    "score": round(rrf_score, 6),
                    "source": source_label,
                }
            )
        )

    fused.sort(key=lambda c: c.score, reverse=True)
    return fused[:top_k]


async def hybrid_search(
    repo_id: str,
    query: str,
    vector_top_k: int = 30,
    keyword_top_k: int = 30,
    fusion_k: int = 60,
    top_k: int = 30,
) -> list[RetrievedChunk]:
    """Execute vector search and ripgrep keyword search concurrently,

    then fuse results using Reciprocal Rank Fusion (k=60).
    """
    vector_task = vector_search(repo_id=repo_id, query=query, top_k=vector_top_k)
    keyword_task = keyword_search(repo_id=repo_id, query=query, top_k=keyword_top_k)

    vec_results, kw_results = await asyncio.gather(vector_task, keyword_task)

    return reciprocal_rank_fusion(
        ranked_lists=[vec_results, kw_results],
        k=fusion_k,
        top_k=top_k,
    )

