from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.retrieval.keyword import (
    RipgrepHit,
    extract_candidate_identifiers,
    keyword_search,
    map_hits_to_chunks,
    run_ripgrep,
)


def test_extract_candidate_identifiers_patterns() -> None:
    query = (
        'Where is "jwt_secret" used in src/middleware/auth.ts, '
        'and does verifyAuthToken handle SessionConfig or MAX_RETRIES?'
    )
    terms = extract_candidate_identifiers(query)

    assert "jwt_secret" in terms
    assert "src/middleware/auth.ts" in terms
    assert "auth.ts" in terms
    assert "verifyAuthToken" in terms
    assert "SessionConfig" in terms
    assert "MAX_RETRIES" in terms

    # Stopwords should not be standalone terms
    lower_terms = [t.lower() for t in terms]
    assert "where" not in lower_terms
    assert "is" not in lower_terms
    assert "and" not in lower_terms
    assert "does" not in lower_terms


def test_extract_candidate_identifiers_general_words() -> None:
    query = "Where is routing handled in Starlette?"
    terms = extract_candidate_identifiers(query)
    assert "routing" in [t.lower() for t in terms]
    assert "starlette" in [t.lower() for t in terms]


@pytest.mark.asyncio
async def test_run_ripgrep_finds_matches() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        base = Path(tmpdir)
        sub = base / "pkg"
        sub.mkdir()
        test_file = sub / "routes.py"
        test_file.write_text(
            "class Router:\n"
            "    def handle(self):\n"
            "        pass\n",
            encoding="utf-8",
        )

        hits = await run_ripgrep(base, ["Router", "handle"])
        assert len(hits) >= 2
        file_paths = {h.file_path for h in hits}
        assert "pkg/routes.py" in file_paths
        line_numbers = {h.line_number for h in hits}
        assert 1 in line_numbers
        assert 2 in line_numbers


@pytest.mark.asyncio
async def test_map_hits_to_chunks_scoring() -> None:
    hits = [
        RipgrepHit(file_path="pkg/routes.py", line_number=1, line_text="class Router:"),
        RipgrepHit(file_path="pkg/routes.py", line_number=2, line_text="    def handle(self):"),
    ]

    mock_db = MagicMock()
    mock_db["chunks"].find.return_value = [
        {
            "_id": "chunk-1",
            "repoId": "repo-test",
            "filePath": "pkg/routes.py",
            "language": "python",
            "symbolName": "Router",
            "symbolType": "class",
            "startLine": 1,
            "endLine": 10,
            "content": "class Router: ...",
        },
        {
            "_id": "chunk-2",
            "repoId": "repo-test",
            "filePath": "pkg/routes.py",
            "language": "python",
            "symbolName": "other_func",
            "symbolType": "function",
            "startLine": 15,
            "endLine": 25,
            "content": "def other(): ...",
        },
    ]

    with patch("app.retrieval.keyword.get_db", return_value=mock_db):
        results = await map_hits_to_chunks("repo-test", hits, ["Router"], top_k=10)

    assert len(results) == 1
    assert results[0].chunk_id == "chunk-1"
    assert results[0].symbol_name == "Router"
    assert results[0].score > 5.0  # Base hit count + symbol match boost


@pytest.mark.asyncio
async def test_keyword_search_handles_missing_repo() -> None:
    with patch("app.retrieval.keyword.get_settings") as mock_settings:
        mock_settings.return_value.repos_dir = "/nonexistent/path"
        results = await keyword_search("fake-repo", "Router")
        assert results == []
