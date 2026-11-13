from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.config import get_settings
from app.db.mongo import get_db
from app.llm import get_llm_client
from app.retrieval.types import RetrievedChunk

logger = logging.getLogger(__name__)

STOP_WORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
    "below", "between", "both", "but", "by", "can", "can't", "cannot", "could",
    "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down",
    "during", "each", "few", "for", "from", "further", "had", "hadn't", "has",
    "hasn't", "have", "haven't", "having", "he", "her", "here", "hers", "herself",
    "him", "himself", "his", "how", "i", "if", "in", "into", "is", "isn't", "it",
    "its", "itself", "let's", "me", "more", "most", "mustn't", "my", "myself",
    "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought",
    "our", "ours", "ourselves", "out", "over", "own", "same", "shan't", "she",
    "should", "shouldn't", "so", "some", "such", "than", "that", "the", "their",
    "theirs", "them", "themselves", "then", "there", "these", "they", "this",
    "those", "through", "to", "too", "under", "until", "up", "very", "was",
    "wasn't", "we", "were", "weren't", "what", "when", "where", "which", "while",
    "who", "whom", "why", "with", "won't", "would", "wouldn't", "you", "your",
    "yours", "yourself", "yourselves",
    # Coding question common words
    "show", "tell", "explain", "find", "get", "code", "repo", "repository",
    "file", "files", "function", "class", "method", "handling", "handled",
    "implemented", "defined", "used", "located", "check", "see",
}


class RipgrepHit(BaseModel):
    file_path: str
    line_number: int
    line_text: str = ""


def extract_candidate_identifiers(query: str) -> list[str]:
    """Extract candidate code identifiers from question:

    - Quoted terms
    - File paths / extensions (e.g. app.py, src/routes/auth.ts)
    - camelCase / PascalCase identifiers
    - snake_case identifiers
    - ALL_CAPS constants
    - Meaningful alphanumeric words of length >= 3 not in stopwords
    """
    candidates: list[str] = []

    # 1. Quoted terms
    for match in re.findall(r'["\']([^"\']+)["\']', query):
        candidates.append(match.strip())

    # 2. File paths and filenames (including nested paths like src/middleware/auth.ts)
    file_matches = re.findall(
        r"\b[A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)+\b|\b[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8}\b",
        query,
    )
    for fm in file_matches:
        candidates.append(fm)
        # Also add base filename without directory
        if "/" in fm:
            candidates.append(fm.split("/")[-1])

    # 3. camelCase / PascalCase
    for cc in re.findall(r"\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b", query):
        candidates.append(cc)

    # 4. snake_case
    for sc in re.findall(r"\b[a-zA-Z0-9]+_[a-zA-Z0-9_]+\b", query):
        candidates.append(sc)

    # 5. ALL_CAPS constants
    for ac in re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", query):
        candidates.append(ac)

    # 6. General alphanumeric terms not in stopwords
    words = re.findall(r"\b[A-Za-z0-9_]{3,}\b", query)
    for w in words:
        if w.lower() not in STOP_WORDS:
            candidates.append(w)

    # Deduplicate preserving order
    seen: set[str] = set()
    result: list[str] = []
    for cand in candidates:
        cleaned = cand.strip()
        if not cleaned or len(cleaned) < 2:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(cleaned)

    return result[:10]


async def propose_search_terms_with_llm(query: str) -> list[str]:
    """Optionally use LLM_FAST_MODEL to propose up to 5 exact code search terms."""
    settings = get_settings()
    if not settings.llm_fast_model:
        return []

    prompt = (
        "Given the following question about a codebase, extract or propose up to 5 concise code "
        "search terms (identifiers, class names, function names, file paths, or keywords) that "
        "would be found literally in the source code.\n"
        "Return ONLY a JSON array of strings, e.g. [\"term1\", \"term2\"]. No other text.\n\n"
        f"Question: {query}"
    )

    try:
        llm = get_llm_client()
        res = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            model=settings.llm_fast_model,
            stream=False,
        )
        content = res.content.strip()
        # Parse JSON array
        start = content.find("[")
        end = content.rfind("]")
        if start != -1 and end != -1:
            parsed = json.loads(content[start : end + 1])
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()][:5]
    except Exception as exc:
        logger.warning("LLM search terms proposal failed: %s", exc)
    return []


async def run_ripgrep(
    repo_base: Path,
    terms: list[str],
    max_matches_per_file: int = 50,
) -> list[RipgrepHit]:
    """Execute ripgrep over repo directory with smart-case fixed-string search."""
    if not repo_base.exists() or not terms:
        return []

    cmd = [
        "rg",
        "--json",
        "--line-number",
        "--max-columns",
        "500",
        "--max-count",
        str(max_matches_per_file),
        "-F",
        "--smart-case",
        "-g",
        "!.git",
        "-g",
        "!node_modules",
        "-g",
        "!.next",
        "-g",
        "!dist",
        "-g",
        "!build",
        "-g",
        "!__pycache__",
    ]
    for term in terms:
        cmd.extend(["-e", term])
    cmd.append(str(repo_base))

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15.0)
    except Exception as exc:
        logger.warning("ripgrep subprocess failed or timed out: %s", exc)
        return []

    hits: list[RipgrepHit] = []
    base_str = str(repo_base.resolve())

    for line in stdout.decode("utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue

        if entry.get("type") == "match":
            data = entry.get("data", {})
            raw_path = data.get("path", {}).get("text", "")
            line_num = data.get("line_number", 0)
            line_text = data.get("lines", {}).get("text", "").strip()

            if not raw_path or not line_num:
                continue

            # Normalize to relative path with forward slashes
            try:
                rel = Path(raw_path).resolve().relative_to(base_str)
                rel_path = str(rel).replace("\\", "/")
            except ValueError:
                rel_path = raw_path.replace("\\", "/")

            hits.append(
                RipgrepHit(
                    file_path=rel_path,
                    line_number=int(line_num),
                    line_text=line_text,
                )
            )

    return hits


async def map_hits_to_chunks(
    repo_id: str,
    hits: list[RipgrepHit],
    candidate_terms: list[str],
    top_k: int = 30,
) -> list[RetrievedChunk]:
    """Map ripgrep hit line numbers to enclosing AST chunks in MongoDB."""
    if not hits:
        return []

    matches_by_file: dict[str, list[int]] = {}
    for hit in hits:
        matches_by_file.setdefault(hit.file_path, []).append(hit.line_number)

    matched_files = list(matches_by_file.keys())
    db = get_db()
    cursor = db["chunks"].find(
        {"repoId": str(repo_id), "filePath": {"$in": matched_files}},
        {"embedding": 0},
    )
    docs = await asyncio.to_thread(lambda: list(cursor))

    candidate_lower = [t.lower() for t in candidate_terms]
    scored_chunks: list[tuple[float, dict[str, Any]]] = []

    for doc in docs:
        file_path = str(doc.get("filePath", ""))
        hit_lines = matches_by_file.get(file_path, [])
        start_line = int(doc.get("startLine", 0))
        end_line = int(doc.get("endLine", 0))

        # Count hit lines falling inside this chunk's line range
        hit_count = sum(1 for ln in hit_lines if start_line <= ln <= end_line)
        if hit_count == 0:
            continue

        symbol_name = str(doc.get("symbolName", "")).lower()
        symbol_type = str(doc.get("symbolType", "block")).lower()

        # Score components:
        # 1. Base hit count
        score = float(hit_count)

        # 2. Boost if symbol name matches any candidate term directly
        matches_symbol = any(
            term in symbol_name or symbol_name in term for term in candidate_lower
        )
        if symbol_name and matches_symbol:
            score += 5.0

        # 3. Preference for dedicated functions / classes over generic module blocks
        if symbol_type in ("function", "class", "method"):
            score += 1.0

        scored_chunks.append((score, doc))

    # Sort descending by score, tie-break by smaller span (more specific chunk)
    scored_chunks.sort(
        key=lambda item: (
            item[0],
            -(int(item[1].get("endLine", 0)) - int(item[1].get("startLine", 0))),
        ),
        reverse=True,
    )

    results: list[RetrievedChunk] = []
    for score, doc in scored_chunks[:top_k]:
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
                score=round(score, 4),
                source="keyword",
            )
        )
    return results


async def keyword_search(
    repo_id: str,
    query: str,
    top_k: int = 30,
    use_llm_expansion: bool = False,
) -> list[RetrievedChunk]:
    """Perform keyword search via ripgrep over repository base directory,

    mapping hits to enclosing code chunks.
    """
    settings = get_settings()
    repo_base = Path(settings.repos_dir) / repo_id / "base"
    if not repo_base.exists():
        logger.warning("Repo base directory not found: %s", repo_base)
        return []

    terms = extract_candidate_identifiers(query)
    if use_llm_expansion and len(terms) < 3:
        extra_terms = await propose_search_terms_with_llm(query)
        for et in extra_terms:
            if et.lower() not in [t.lower() for t in terms]:
                terms.append(et)

    if not terms:
        return []

    hits = await run_ripgrep(repo_base=repo_base, terms=terms)
    return await map_hits_to_chunks(
        repo_id=repo_id,
        hits=hits,
        candidate_terms=terms,
        top_k=top_k,
    )
