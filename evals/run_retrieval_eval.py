#!/usr/bin/env python3
"""Retrieval Evaluation Suite for CodeScout

Evaluates retrieval quality across three variants:
  1. Vector search only (top 10)
  2. Hybrid fusion (vector top 30 + keyword top 30 fused with RRF k=60, top 10)
  3. Hybrid + Reranking (fused top 30 reranked with RERANK_MODEL, top 10)

Metrics:
  - Recall@5 (Hit@5): is an expected ground-truth file in top 5 chunks?
  - Recall@10 (Hit@10): is an expected ground-truth file in top 10 chunks?
  - MRR: Mean Reciprocal Rank of the first matching ground-truth file.
  - Latency: Average wall-clock milliseconds per query.

Saves results to the `eval_runs` MongoDB collection and prints a comparison table.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from bson import ObjectId

# Ensure app package is importable both inside Docker (/app) and on host
current_dir = Path(__file__).resolve().parent
for candidate in [Path("/app"), current_dir.parent / "services" / "agent", current_dir.parent]:
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app.config import get_settings  # noqa: E402
from app.db.mongo import get_db  # noqa: E402
from app.indexing import index_repository  # noqa: E402
from app.retrieval import RetrievalConfig, retrieve_chunks  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("eval_retrieval")


async def ensure_repo_indexed(dataset: dict[str, Any]) -> str:
    """Ensure the benchmark repository is indexed in MongoDB and cloned on disk.

    Returns the repoId (hex string).
    """
    db = get_db()
    full_name = dataset["repo"]
    commit_sha = dataset.get("commitSha", "")

    existing = db["repos"].find_one({"fullName": full_name, "status": "ready"})
    if existing:
        repo_id = str(existing["_id"])
        chunk_count = db["chunks"].count_documents({"repoId": repo_id})
        logger.info(
            "Found ready repository '%s' (id=%s) with %d chunks.",
            full_name,
            repo_id,
            chunk_count,
        )
        return repo_id

    # Create new repo entry
    repo_oid = ObjectId()
    repo_id = str(repo_oid)
    owner, name = full_name.split("/")
    db["repos"].insert_one(
        {
            "_id": repo_oid,
            "owner": owner,
            "name": name,
            "fullName": full_name,
            "defaultBranch": "main",
            "commitSha": commit_sha,
            "status": "pending",
            "progress": {"stage": "queued", "processedFiles": 0, "totalFiles": 0},
            "createdAt": datetime.now(UTC),
        }
    )

    logger.info("Indexing benchmark repo '%s' (id=%s)...", full_name, repo_id)
    result = await index_repository(
        repo_id=repo_id,
        clone_url=dataset["cloneUrl"],
    )
    logger.info(
        "Indexing completed with status '%s': stats=%s",
        result["status"],
        result.get("stats"),
    )
    return repo_id


def evaluate_hits(
    retrieved_file_paths: list[str],
    expected_files: list[str],
) -> tuple[float, float, float]:
    """Calculate (Recall@5, Recall@10, ReciprocalRank) for a single question."""
    normalized_expected = {f.lower().strip() for f in expected_files}
    normalized_retrieved = [p.lower().strip() for p in retrieved_file_paths]

    top_5 = normalized_retrieved[:5]
    top_10 = normalized_retrieved[:10]

    recall_5 = 1.0 if any(exp in top_5 for exp in normalized_expected) else 0.0
    recall_10 = 1.0 if any(exp in top_10 for exp in normalized_expected) else 0.0

    reciprocal_rank = 0.0
    for rank, p in enumerate(normalized_retrieved, start=1):
        if p in normalized_expected:
            reciprocal_rank = 1.0 / rank
            break

    return recall_5, recall_10, reciprocal_rank


async def evaluate_question(
    repo_id: str,
    question_data: dict[str, Any],
    variants: dict[str, RetrievalConfig],
) -> dict[str, Any]:
    """Run a single question through all configured retrieval variants."""
    q_text = question_data["question"]
    expected_files = question_data["expectedFiles"]
    q_id = question_data.get("id", "q")

    variant_metrics: dict[str, Any] = {}

    for var_name, cfg in variants.items():
        start = time.perf_counter()
        try:
            chunks = await retrieve_chunks(repo_id=repo_id, query=q_text, config=cfg)
            latency_ms = (time.perf_counter() - start) * 1000.0
            retrieved_files = [c.file_path for c in chunks]
            r5, r10, rr = evaluate_hits(retrieved_files, expected_files)

            variant_metrics[var_name] = {
                "recall@5": r5,
                "recall@10": r10,
                "rr": rr,
                "latencyMs": round(latency_ms, 2),
                "retrievedFiles": retrieved_files[:5],
                "topScore": chunks[0].score if chunks else 0.0,
            }
        except Exception as exc:
            logger.error("Variant %s failed on %s: %s", var_name, q_id, exc)
            variant_metrics[var_name] = {
                "recall@5": 0.0,
                "recall@10": 0.0,
                "rr": 0.0,
                "latencyMs": 0.0,
                "error": str(exc),
            }

    return {
        "id": q_id,
        "question": q_text,
        "expectedFiles": expected_files,
        "variants": variant_metrics,
    }


def print_comparison_table(
    summary: dict[str, dict[str, float]],
    total_questions: int,
) -> None:
    """Print an aligned ASCII comparison table for the evaluation summary."""
    sep = "=" * 88
    line = "-" * 88
    print("\n" + sep)
    print(f"             CODESCOUT RETRIEVAL EVALUATION RESULTS (N={total_questions})")
    print(sep)
    hdr = (
        f"{'Variant':<16} | {'Recall@5':<10} | {'Recall@10':<10} | "
        f"{'MRR':<10} | {'Latency(ms)':<12}"
    )
    print(hdr)
    print(line)
    for var_name, m in summary.items():
        print(
            f"{var_name:<20} | {m['recall@5']:<12.4f} | {m['recall@10']:<12.4f} | "
            f"{m['mrr']:<12.4f} | {m['avgLatencyMs']:<16.2f}"
        )
    print(sep + "\n")


async def main() -> None:
    parser = argparse.ArgumentParser(description="CodeScout Retrieval Evaluation Suite")
    parser.add_argument(
        "--repo",
        choices=["starlette", "hono", "zustand", "all"],
        default="all",
        help="Repository benchmark to run (default: all)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of questions evaluated per repo (for quick testing)",
    )
    args = parser.parse_args()

    settings = get_settings()
    evals_dir = Path(__file__).resolve().parent / "retrieval"
    if not evals_dir.exists():
        evals_dir = Path("/app/evals/retrieval")

    target_files: list[Path] = []
    if args.repo in ("starlette", "all"):
        target_files.append(evals_dir / "starlette.json")
    if args.repo in ("hono", "all"):
        target_files.append(evals_dir / "hono.json")
    if args.repo in ("zustand", "all"):
        target_files.append(evals_dir / "zustand.json")

    datasets: list[dict[str, Any]] = []
    for f in target_files:
        if f.exists():
            datasets.append(json.loads(f.read_text(encoding="utf-8")))
        else:
            logger.warning("Dataset file not found: %s", f)

    if not datasets:
        logger.error("No benchmark datasets loaded. Exiting.")
        sys.exit(1)

    variants: dict[str, RetrievalConfig] = {
        "vector_only": RetrievalConfig.vector_only(top_k=10),
        "hybrid": RetrievalConfig.hybrid_only(vector_top_k=30, keyword_top_k=30, top_k=10),
        "hybrid_rerank": RetrievalConfig.hybrid_rerank(
            vector_top_k=30,
            keyword_top_k=30,
            fusion_k=60,
            fused_top_k=30,
            top_k=10,
        ),
    }

    all_question_results: list[dict[str, Any]] = []

    for ds in datasets:
        repo_name = ds["repo"]
        logger.info("=== Preparing benchmark repository: %s ===", repo_name)
        repo_id = await ensure_repo_indexed(ds)

        questions = ds["questions"]
        if args.limit and args.limit > 0:
            questions = questions[: args.limit]

        logger.info(
            "Evaluating %d questions on %s across %s...",
            len(questions),
            repo_name,
            list(variants.keys()),
        )

        for idx, q in enumerate(questions, start=1):
            logger.info("[%d/%d] %s: %s", idx, len(questions), q.get("id"), q["question"][:60])
            res = await evaluate_question(repo_id, q, variants)
            res["repo"] = repo_name
            all_question_results.append(res)

    total_q = len(all_question_results)
    if total_q == 0:
        logger.error("No questions evaluated.")
        sys.exit(1)

    summary_metrics: dict[str, dict[str, float]] = {}
    for var_name in variants:
        r5_vals = [q["variants"][var_name]["recall@5"] for q in all_question_results]
        r10_vals = [q["variants"][var_name]["recall@10"] for q in all_question_results]
        rr_vals = [q["variants"][var_name]["rr"] for q in all_question_results]
        lat_vals = [q["variants"][var_name]["latencyMs"] for q in all_question_results]

        summary_metrics[var_name] = {
            "recall@5": round(sum(r5_vals) / total_q, 4),
            "recall@10": round(sum(r10_vals) / total_q, 4),
            "mrr": round(sum(rr_vals) / total_q, 4),
            "avgLatencyMs": round(sum(lat_vals) / total_q, 2),
        }

    print_comparison_table(summary_metrics, total_q)

    # Save to MongoDB eval_runs collection
    db = get_db()
    eval_run_doc = {
        "suite": "retrieval",
        "createdAt": datetime.now(UTC),
        "configSnapshot": {
            "embeddingModel": settings.embedding_model,
            "rerankModel": settings.rerank_model,
            "llmFastModel": settings.llm_fast_model,
            "variants": list(variants.keys()),
        },
        "repos": [ds["repo"] for ds in datasets],
        "totalQuestions": total_q,
        "metrics": summary_metrics,
        "results": all_question_results,
    }
    inserted = db["eval_runs"].insert_one(eval_run_doc)
    logger.info("Saved eval run to MongoDB 'eval_runs' (id=%s)", str(inserted.inserted_id))


if __name__ == "__main__":
    asyncio.run(main())
