import asyncio
from typing import Any

from pydantic import BaseModel

from app.db.mongo import get_db
from app.llm import get_llm_client


class RetrievedChunk(BaseModel):
    chunk_id: str
    repo_id: str
    file_path: str
    language: str
    symbol_name: str
    symbol_type: str
    start_line: int
    end_line: int
    content: str
    score: float = 0.0


async def vector_search(
    repo_id: str,
    query: str,
    top_k: int = 8,
) -> list[RetrievedChunk]:
    llm = get_llm_client()
    embed_res = await llm.embed([query], input_type="query")
    if not embed_res.embeddings:
        return []
    query_vector = embed_res.embeddings[0]

    db = get_db()
    pipeline: list[dict[str, Any]] = [
        {
            "$vectorSearch": {
                "index": "chunks_vector",
                "path": "embedding",
                "queryVector": query_vector,
                "numCandidates": max(top_k * 10, 80),
                "limit": top_k,
                "filter": {"repoId": repo_id},
            }
        },
        {
            "$project": {
                "_id": 1,
                "repoId": 1,
                "filePath": 1,
                "language": 1,
                "symbolName": 1,
                "symbolType": 1,
                "startLine": 1,
                "endLine": 1,
                "content": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]

    docs = await asyncio.to_thread(lambda: list(db["chunks"].aggregate(pipeline)))
    results: list[RetrievedChunk] = []
    for doc in docs:
        results.append(
            RetrievedChunk(
                chunk_id=str(doc["_id"]),
                repo_id=str(doc["repoId"]),
                file_path=str(doc["filePath"]),
                language=str(doc.get("language", "text")),
                symbol_name=str(doc.get("symbolName", "")),
                symbol_type=str(doc.get("symbolType", "block")),
                start_line=int(doc["startLine"]),
                end_line=int(doc["endLine"]),
                content=str(doc["content"]),
                score=float(doc.get("score", 0.0)),
            )
        )
    return results

