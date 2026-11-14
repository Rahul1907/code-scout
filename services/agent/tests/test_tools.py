from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.tools import (
    FindSymbolInput,
    GrepInput,
    ListDirectoryInput,
    PathSecurityError,
    ReadFileInput,
    SearchCodeInput,
    execute_find_symbol,
    execute_grep,
    execute_list_directory,
    execute_read_file,
    execute_search_code,
    execute_tool,
    sanitize_and_resolve_path,
)
from app.retrieval.types import RetrievedChunk


def test_sanitize_and_resolve_path_valid(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    sub_file = repo_dir / "src" / "index.ts"
    sub_file.parent.mkdir()
    sub_file.write_text("console.log('hi');")

    resolved = sanitize_and_resolve_path(repo_dir, "src/index.ts")
    assert resolved == sub_file.resolve()

    resolved_root = sanitize_and_resolve_path(repo_dir, ".")
    assert resolved_root == repo_dir.resolve()


def test_sanitize_and_resolve_path_blocks_traversal(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    with pytest.raises(PathSecurityError, match="path traversal"):
        sanitize_and_resolve_path(repo_dir, "../secret.txt")

    with pytest.raises(PathSecurityError, match="path traversal"):
        sanitize_and_resolve_path(repo_dir, "src/../../etc/passwd")


@pytest.mark.asyncio
async def test_read_file_success(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    sample = repo_dir / "sample.py"
    sample.write_text("line 1\nline 2\nline 3\nline 4\nline 5\n")

    res = await execute_read_file(
        repo_dir,
        ReadFileInput(path="sample.py", start_line=2, end_line=4),
    )
    assert "=== File: sample.py (Lines 2-4 of 5) ===" in res
    assert "2 | line 2" in res
    assert "3 | line 3" in res
    assert "4 | line 4" in res
    assert "1 | line 1" not in res


@pytest.mark.asyncio
async def test_read_file_caps_at_400_lines(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    sample = repo_dir / "big.txt"
    sample.write_text("\n".join(f"line {i}" for i in range(1, 600)))

    res = await execute_read_file(
        repo_dir,
        ReadFileInput(path="big.txt", start_line=1, end_line=550),
    )
    assert "[truncated: capped at 400 lines per call" in res
    assert "400 | line 400" in res
    assert "401 | line 401" not in res


@pytest.mark.asyncio
async def test_read_file_not_found(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    res = await execute_read_file(repo_dir, ReadFileInput(path="missing.txt"))
    assert "File not found" in res


@pytest.mark.asyncio
async def test_list_directory(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    (repo_dir / "src").mkdir()
    (repo_dir / "src" / "app.ts").write_text("export const a = 1;")
    (repo_dir / "README.md").write_text("# Test Repo")
    (repo_dir / ".git").mkdir()  # Should be ignored

    res = await execute_list_directory(repo_dir, ListDirectoryInput(path="."))
    assert "=== Directory: ." in res
    assert "[dir]  src/" in res
    assert "[file] README.md" in res
    assert ".git" not in res


@pytest.mark.asyncio
async def test_grep(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    f1 = repo_dir / "hello.py"
    f1.write_text("def hello_world():\n    return 'hello'\n")

    res = await execute_grep(repo_dir, GrepInput(pattern="hello_world"))
    assert "hello.py" in res
    assert "def hello_world():" in res


@pytest.mark.asyncio
async def test_find_symbol() -> None:
    mock_db = MagicMock()
    mock_cursor = [
        {
            "filePath": "src/router.py",
            "startLine": 10,
            "endLine": 50,
            "symbolType": "class",
            "symbolName": "Router",
            "content": "class Router:\n    def __init__(self):\n        pass",
        }
    ]
    mock_db.__getitem__.return_value.find.return_value = mock_cursor

    with patch("app.agent.tools.get_db", return_value=mock_db):
        res = await execute_find_symbol("fake-repo", FindSymbolInput(name="Router"))
        assert "Found 1 matching symbol(s) for 'Router'" in res
        assert "class Router at [src/router.py:10-50]" in res


@pytest.mark.asyncio
async def test_search_code() -> None:
    chunk = RetrievedChunk(
        chunk_id="c1",
        repo_id="r1",
        file_path="pkg/main.py",
        language="python",
        symbol_name="start_server",
        symbol_type="function",
        start_line=20,
        end_line=45,
        content="def start_server():\n    pass",
        score=0.92,
        source="hybrid",
    )

    with patch("app.agent.tools.retrieve_chunks", AsyncMock(return_value=[chunk])):
        res = await execute_search_code("r1", SearchCodeInput(query="server"))
        assert "Found 1 relevant code excerpt(s)" in res
        assert "[pkg/main.py:20-45]" in res
        assert "def start_server():" in res


@pytest.mark.asyncio
async def test_execute_tool_dispatch(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    (repo_dir / "index.js").write_text("console.log('hello');")

    res = await execute_tool(
        tool_name="read_file",
        arguments=json.dumps({"path": "index.js"}),
        repo_id="r1",
        repo_dir=repo_dir,
    )
    assert "=== File: index.js" in res
    assert "console.log('hello');" in res

    bad_tool = await execute_tool(
        tool_name="nonexistent",
        arguments={},
        repo_id="r1",
        repo_dir=repo_dir,
    )
    assert "Unknown tool 'nonexistent'" in bad_tool

    bad_json = await execute_tool(
        tool_name="read_file",
        arguments="{bad_json",
        repo_id="r1",
        repo_dir=repo_dir,
    )
    assert "Tool arguments must be valid JSON" in bad_json
