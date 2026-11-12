import asyncio
import json
import logging
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from bson import ObjectId

from app.config import get_settings
from app.db.mongo import get_db
from app.indexing.chunker import CodeChunk, chunk_file, format_chunk_for_embedding
from app.indexing.clone import clone_repository
from app.indexing.walker import walk_repo_files
from app.llm import get_llm_client

logger = logging.getLogger("codescout.indexing")


def _update_repo(repo_oid: ObjectId, fields: dict[str, Any]) -> None:
    db = get_db()
    db["repos"].update_one({"_id": repo_oid}, {"$set": fields})


async def index_repository(
    repo_id: str,
    clone_url: str,
    token: str | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    repo_oid = ObjectId(repo_id)
    db = get_db()

    try:
        _update_repo(
            repo_oid,
            {
                "status": "cloning",
                "progress": {"stage": "cloning", "processedFiles": 0, "totalFiles": 0},
                "error": "",
            },
        )

        base_dir, commit_sha = await asyncio.to_thread(
            clone_repository,
            repo_id,
            clone_url,
            token,
            settings.repos_dir,
        )

        rel_files = await asyncio.to_thread(walk_repo_files, base_dir, settings.max_files_per_repo)
        total_files = len(rel_files)

        _update_repo(
            repo_oid,
            {
                "commitSha": commit_sha,
                "status": "indexing",
                "progress": {"stage": "chunking", "processedFiles": 0, "totalFiles": total_files},
            },
        )

        def _chunk_all() -> tuple[list[tuple[int, CodeChunk]], dict[str, int]]:
            indexed_chunks: list[tuple[int, CodeChunk]] = []
            lang_counts: Counter[str] = Counter()
            for file_idx, rel in enumerate(rel_files):
                abs_path = Path(base_dir) / rel
                content = abs_path.read_text(encoding="utf-8", errors="replace")
                file_chunks = chunk_file(rel.as_posix(), content)
                if file_chunks:
                    lang_counts[file_chunks[0].language] += 1
                    for c in file_chunks:
                        indexed_chunks.append((file_idx, c))
            return indexed_chunks, dict(lang_counts)

        all_chunks, language_stats = await asyncio.to_thread(_chunk_all)

        # Clear stale chunks before inserting fresh index
        await asyncio.to_thread(db["chunks"].delete_many, {"repoId": repo_id})

        batch_size = max(1, settings.embedding_batch_size)
        llm = get_llm_client()
        total_chunks = len(all_chunks)

        for start_idx in range(0, total_chunks, batch_size):
            batch = all_chunks[start_idx : start_idx + batch_size]
            texts = [format_chunk_for_embedding(chunk) for _, chunk in batch]
            embed_res = await llm.embed(texts, input_type="passage")

            docs = []
            for (_, chunk), vector in zip(batch, embed_res.embeddings, strict=True):
                docs.append(
                    {
                        "repoId": repo_id,
                        "filePath": chunk.file_path,
                        "language": chunk.language,
                        "symbolName": chunk.symbol_name,
                        "symbolType": chunk.symbol_type,
                        "startLine": chunk.start_line,
                        "endLine": chunk.end_line,
                        "content": chunk.content,
                        "contentHash": chunk.content_hash,
                        "embedding": vector,
                    }
                )

            if docs:
                await asyncio.to_thread(db["chunks"].insert_many, docs)

            processed_files = min(total_files, batch[-1][0] + 1)
            await asyncio.to_thread(
                _update_repo,
                repo_oid,
                {
                    "progress": {
                        "stage": "embedding",
                        "processedFiles": processed_files,
                        "totalFiles": total_files,
                    }
                },
            )

        stats = {
            "files": total_files,
            "chunks": total_chunks,
            "languages": language_stats,
        }
        await asyncio.to_thread(
            _update_repo,
            repo_oid,
            {
                "status": "ready",
                "progress": {
                    "stage": "ready",
                    "processedFiles": total_files,
                    "totalFiles": total_files,
                },
                "stats": stats,
                "indexedAt": datetime.now(UTC),
                "error": "",
            },
        )
        logger.info(
            json.dumps(
                {
                    "event": "repo_indexed",
                    "repoId": repo_id,
                    "commitSha": commit_sha,
                    "files": total_files,
                    "chunks": total_chunks,
                }
            )
        )
        return {"status": "ready", "repoId": repo_id, "commitSha": commit_sha, "stats": stats}
    except Exception as exc:
        err_msg = str(exc)
        if token:
            err_msg = err_msg.replace(token, "***")
        await asyncio.to_thread(
            _update_repo,
            repo_oid,
            {
                "status": "failed",
                "error": err_msg[:1000],
            },
        )
        raise
