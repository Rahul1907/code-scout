from __future__ import annotations

import logging

from app.llm import get_llm_client
from app.retrieval.types import RetrievedChunk

logger = logging.getLogger(__name__)


def format_chunk_for_rerank(chunk: RetrievedChunk, max_chars: int = 4000) -> str:
    header = (
        f"File: {chunk.file_path}\n"
        f"Symbol: {chunk.symbol_type} {chunk.symbol_name} "
        f"(lines {chunk.start_line}-{chunk.end_line})\n\n"
    )
    code = chunk.content[:max_chars]
    return f"{header}{code}"


async def rerank_chunks(
    query: str,
    chunks: list[RetrievedChunk],
    top_k: int = 8,
    model: str | None = None,
) -> list[RetrievedChunk]:
    """Rerank candidate chunks using RERANK_MODEL.

    If the reranker fails or is rate-limited, logs the error and gracefully falls
    back to the original fused ranking order.
    """
    if not chunks:
        return []

    # If already fewer than or equal to top_k and no reranking requested, return as-is
    passages = [format_chunk_for_rerank(c) for c in chunks]

    try:
        llm = get_llm_client()
        rerank_res = await llm.rerank(
            query=query,
            documents=passages,
            model=model,
            top_n=top_k,
        )

        reranked: list[RetrievedChunk] = []
        for item in rerank_res.results:
            if 0 <= item.index < len(chunks):
                original = chunks[item.index]
                reranked.append(
                    original.model_copy(
                        update={
                            "score": round(item.score, 4),
                        }
                    )
                )

        if reranked:
            return reranked

    except Exception as exc:
        logger.warning(
            "Reranker failed (%s: %s); falling back to fused order",
            type(exc).__name__,
            exc,
        )

    # Fallback: keep original fused order truncated to top_k
    return chunks[:top_k]
