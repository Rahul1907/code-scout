from __future__ import annotations

import asyncio

from pydantic import BaseModel, Field

from app.retrieval.fusion import reciprocal_rank_fusion
from app.retrieval.keyword import keyword_search
from app.retrieval.rerank import rerank_chunks
from app.retrieval.types import RetrievedChunk
from app.retrieval.vector import vector_search


class RetrievalConfig(BaseModel):
    """Unified retrieval configuration object allowing full parameterization

    across vector, keyword, fusion, and reranking stages.
    """

    use_vector: bool = True
    use_keyword: bool = True
    use_reranker: bool = True
    use_llm_keyword_expansion: bool = False

    vector_top_k: int = Field(default=30, ge=1, le=100)
    keyword_top_k: int = Field(default=30, ge=1, le=100)
    fusion_k: int = Field(default=60, ge=1, le=200)
    fused_top_k: int = Field(default=30, ge=1, le=100)
    rerank_top_k: int = Field(default=8, ge=1, le=50)
    rerank_model: str | None = None

    @classmethod
    def vector_only(cls, top_k: int = 8) -> RetrievalConfig:
        return cls(
            use_vector=True,
            use_keyword=False,
            use_reranker=False,
            vector_top_k=top_k,
            rerank_top_k=top_k,
        )

    @classmethod
    def keyword_only(cls, top_k: int = 8) -> RetrievalConfig:
        return cls(
            use_vector=False,
            use_keyword=True,
            use_reranker=False,
            keyword_top_k=top_k,
            rerank_top_k=top_k,
        )

    @classmethod
    def hybrid_only(
        cls,
        vector_top_k: int = 30,
        keyword_top_k: int = 30,
        fusion_k: int = 60,
        top_k: int = 8,
    ) -> RetrievalConfig:
        return cls(
            use_vector=True,
            use_keyword=True,
            use_reranker=False,
            vector_top_k=vector_top_k,
            keyword_top_k=keyword_top_k,
            fusion_k=fusion_k,
            fused_top_k=max(top_k, 30),
            rerank_top_k=top_k,
        )

    @classmethod
    def hybrid_rerank(
        cls,
        vector_top_k: int = 30,
        keyword_top_k: int = 30,
        fusion_k: int = 60,
        fused_top_k: int = 30,
        top_k: int = 8,
        rerank_model: str | None = None,
    ) -> RetrievalConfig:
        return cls(
            use_vector=True,
            use_keyword=True,
            use_reranker=True,
            vector_top_k=vector_top_k,
            keyword_top_k=keyword_top_k,
            fusion_k=fusion_k,
            fused_top_k=fused_top_k,
            rerank_top_k=top_k,
            rerank_model=rerank_model,
        )


async def retrieve_chunks(
    repo_id: str,
    query: str,
    config: RetrievalConfig | None = None,
) -> list[RetrievedChunk]:
    """Retrieve code chunks according to the supplied RetrievalConfig.

    Supports vector-only, keyword-only, hybrid fusion, and hybrid + reranking.
    """
    if config is None:
        config = RetrievalConfig()

    candidates: list[RetrievedChunk]

    if config.use_vector and config.use_keyword:
        vec_task = vector_search(repo_id, query, top_k=config.vector_top_k)
        kw_task = keyword_search(
            repo_id,
            query,
            top_k=config.keyword_top_k,
            use_llm_expansion=config.use_llm_keyword_expansion,
        )
        vec_chunks, kw_chunks = await asyncio.gather(vec_task, kw_task)
        candidates = reciprocal_rank_fusion(
            [vec_chunks, kw_chunks],
            k=config.fusion_k,
            top_k=config.fused_top_k,
        )
    elif config.use_vector:
        candidates = await vector_search(repo_id, query, top_k=config.vector_top_k)
    elif config.use_keyword:
        candidates = await keyword_search(
            repo_id,
            query,
            top_k=config.keyword_top_k,
            use_llm_expansion=config.use_llm_keyword_expansion,
        )
    else:
        return []

    if config.use_reranker and candidates:
        return await rerank_chunks(
            query=query,
            chunks=candidates,
            top_k=config.rerank_top_k,
            model=config.rerank_model,
        )

    return candidates[: config.rerank_top_k]
