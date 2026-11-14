from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.db.mongo import get_db
from app.retrieval import RetrievalConfig, retrieve_chunks

logger = logging.getLogger(__name__)

IGNORED_NAMES = {
    ".git",
    "node_modules",
    "__pycache__",
    ".next",
    "dist",
    "build",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
}


class PathSecurityError(ValueError):
    """Raised when a path attempts directory traversal or points outside repository."""


def sanitize_and_resolve_path(repo_dir: Path, user_path: str) -> Path:
    """Safely resolve user_path relative to repo_dir, strictly preventing path traversal."""
    clean_path = user_path.strip().replace("\\", "/")
    # Reject explicit parent directory traversal tokens before resolving
    parts = [p for p in clean_path.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise PathSecurityError(
            f"Access denied: path traversal ('..') detected in '{user_path}'"
        )

    # Resolve against the repo root
    resolved_repo = repo_dir.resolve()
    resolved_target = (repo_dir / "/".join(parts)).resolve()

    try:
        resolved_target.relative_to(resolved_repo)
    except ValueError as exc:
        raise PathSecurityError(
            f"Access denied: path '{user_path}' is outside repository root"
        ) from exc

    return resolved_target


class SearchCodeInput(BaseModel):
    query: str = Field(
        ...,
        description="Natural language query or code search terms to retrieve relevant snippets.",
    )
    top_k: int = Field(
        default=8,
        ge=1,
        le=30,
        description="Number of top chunks to retrieve (default: 8).",
    )


class GrepInput(BaseModel):
    pattern: str = Field(
        ...,
        description="Text or regular expression pattern to search across files with ripgrep.",
    )
    path_glob: str | None = Field(
        default=None,
        description="Optional glob filter to restrict files (e.g. '*.py' or 'src/**').",
    )


class ReadFileInput(BaseModel):
    path: str = Field(
        ...,
        description="Relative path of the file to read inside the repository.",
    )
    start_line: int | None = Field(
        default=None,
        ge=1,
        description="Optional 1-indexed starting line number (default: 1).",
    )
    end_line: int | None = Field(
        default=None,
        ge=1,
        description="Optional 1-indexed ending line number (inclusive).",
    )


class ListDirectoryInput(BaseModel):
    path: str = Field(
        default=".",
        description="Relative directory path to list (default: '.' for repository root).",
    )


class FindSymbolInput(BaseModel):
    name: str = Field(
        ...,
        description="Symbol name to find (class, function, or method name).",
    )


async def execute_search_code(
    repo_id: str,
    args: SearchCodeInput,
) -> str:
    """Retrieve code chunks using hybrid search and reranking."""
    config = RetrievalConfig.hybrid_rerank(top_k=args.top_k)
    chunks = await retrieve_chunks(repo_id=repo_id, query=args.query, config=config)

    if not chunks:
        return f"No matching code excerpts found for query: '{args.query}'"

    formatted: list[str] = [f"Found {len(chunks)} relevant code excerpt(s):"]
    for idx, c in enumerate(chunks, start=1):
        symbol_info = f" ({c.symbol_type} {c.symbol_name})" if c.symbol_name else ""
        header = (
            f"--- [{idx}] [{c.file_path}:{c.start_line}-{c.end_line}]{symbol_info} "
            f"score={c.score:.4f} source={c.source} ---"
        )
        formatted.append(f"{header}\n{c.content}\n")
    return "\n".join(formatted)


async def execute_grep(
    repo_dir: Path,
    args: GrepInput,
    max_matches: int = 50,
) -> str:
    """Run ripgrep over repo directory with line numbers and optional glob."""
    if not repo_dir.exists():
        return f"Repository directory not found on disk: {repo_dir}"

    cmd = [
        "rg",
        "--line-number",
        "--smart-case",
        "--max-columns",
        "500",
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
    if args.path_glob:
        cmd.extend(["-g", args.path_glob])
    cmd.extend(["--", args.pattern, str(repo_dir)])

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=20.0)
    except TimeoutError:
        return "grep timed out after 20 seconds."
    except Exception as exc:
        return f"Error executing grep: {exc}"

    if proc.returncode not in (0, 1):
        err_msg = stderr.decode("utf-8", errors="replace").strip()
        return f"grep error (exit code {proc.returncode}): {err_msg}"

    output_text = stdout.decode("utf-8", errors="replace")
    raw_lines = [line for line in output_text.splitlines() if line.strip()]

    if not raw_lines:
        glob_note = f" matching glob '{args.path_glob}'" if args.path_glob else ""
        return f"No matches found for pattern '{args.pattern}'{glob_note}."

    repo_prefix = f"{repo_dir.resolve()}/".replace("\\", "/")
    repo_prefix_raw = f"{repo_dir}/"

    clean_matches: list[str] = []
    for line in raw_lines[:max_matches]:
        normalized = line.replace("\\", "/")
        if normalized.startswith(repo_prefix):
            normalized = normalized[len(repo_prefix) :]
        elif line.startswith(repo_prefix_raw):
            normalized = line[len(repo_prefix_raw) :]
        clean_matches.append(normalized)

    result = "\n".join(clean_matches)
    if len(raw_lines) > max_matches:
        result += f"\n\n[truncated: showing {max_matches} of {len(raw_lines)} matches]"
    return result


async def execute_read_file(
    repo_dir: Path,
    args: ReadFileInput,
    max_lines: int = 400,
) -> str:
    """Read file content with line numbers (max 400 lines per call)."""
    try:
        target_path = sanitize_and_resolve_path(repo_dir, args.path)
    except PathSecurityError as sec_err:
        return str(sec_err)

    if not target_path.exists():
        return f"File not found: '{args.path}'"
    if not target_path.is_file():
        return f"Path is not a regular file: '{args.path}'"

    try:
        content = target_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return f"Error reading file '{args.path}': {exc}"

    lines = content.splitlines()
    total_lines = len(lines)
    if total_lines == 0:
        return f"File '{args.path}' is empty (0 lines)."

    start = max(1, args.start_line if args.start_line is not None else 1)
    end = min(total_lines, args.end_line if args.end_line is not None else total_lines)

    if start > total_lines:
        return f"start_line ({start}) exceeds total line count ({total_lines}) of '{args.path}'."
    if start > end:
        return f"start_line ({start}) cannot be greater than end_line ({end})."

    truncated = False
    requested_count = end - start + 1
    if requested_count > max_lines:
        end = start + max_lines - 1
        truncated = True

    # 1-indexed slicing
    selected = lines[start - 1 : end]
    padding = len(str(end))
    numbered_lines = [
        f"{line_num:>{padding}} | {text}"
        for line_num, text in zip(range(start, end + 1), selected, strict=True)
    ]

    result = f"=== File: {args.path} (Lines {start}-{end} of {total_lines}) ===\n"
    result += "\n".join(numbered_lines)
    if truncated:
        result += (
            f"\n\n[truncated: capped at {max_lines} lines per call; "
            f"file has {total_lines} lines total]"
        )
    return result


async def execute_list_directory(
    repo_dir: Path,
    args: ListDirectoryInput,
) -> str:
    """List directory entries (files and directories) relative to repo root."""
    try:
        target_dir = sanitize_and_resolve_path(repo_dir, args.path)
    except PathSecurityError as sec_err:
        return str(sec_err)

    if not target_dir.exists():
        return f"Directory not found: '{args.path}'"
    if not target_dir.is_dir():
        return f"Path is not a directory: '{args.path}'"

    dirs: list[str] = []
    files: list[str] = []

    try:
        for entry in sorted(target_dir.iterdir(), key=lambda p: p.name.lower()):
            if entry.name in IGNORED_NAMES:
                continue
            if entry.is_dir():
                dirs.append(f"[dir]  {entry.name}/")
            else:
                try:
                    size_kb = entry.stat().st_size / 1024.0
                    files.append(f"[file] {entry.name} ({size_kb:.1f} KB)")
                except OSError:
                    files.append(f"[file] {entry.name}")
    except Exception as exc:
        return f"Error listing directory '{args.path}': {exc}"

    clean_rel = args.path.strip().replace("\\", "/") or "."
    header = f"=== Directory: {clean_rel} ({len(dirs)} directories, {len(files)} files) ==="
    entries = dirs + files
    if not entries:
        return f"{header}\n(empty directory)"
    return f"{header}\n" + "\n".join(entries)


async def execute_find_symbol(
    repo_id: str,
    args: FindSymbolInput,
) -> str:
    """Find symbols by name in indexed repository chunks."""
    db = get_db()
    name_clean = args.name.strip()
    if not name_clean:
        return "Symbol name cannot be empty."

    # First try exact match (case-insensitive)
    exact_pattern = f"^{re.escape(name_clean)}$"
    cursor = db["chunks"].find(
        {
            "repoId": repo_id,
            "symbolName": {"$regex": exact_pattern, "$options": "i"},
        },
        limit=10,
    )
    docs = await asyncio.to_thread(list, cursor)

    # Fallback to substring match if no exact match found
    if not docs:
        sub_pattern = re.escape(name_clean)
        sub_cursor = db["chunks"].find(
            {
                "repoId": repo_id,
                "symbolName": {"$regex": sub_pattern, "$options": "i"},
            },
            limit=10,
        )
        docs = await asyncio.to_thread(list, sub_cursor)

    if not docs:
        return f"Symbol '{name_clean}' not found in indexed chunks."

    results: list[str] = [f"Found {len(docs)} matching symbol(s) for '{name_clean}':"]
    for idx, doc in enumerate(docs, start=1):
        file_path = doc.get("filePath", "")
        start_line = doc.get("startLine", 1)
        end_line = doc.get("endLine", start_line)
        symbol_type = doc.get("symbolType", "symbol")
        symbol_name = doc.get("symbolName", "")
        content = doc.get("content", "")
        preview_lines = content.splitlines()[:5]
        preview = "\n".join(preview_lines)

        header = (
            f"--- [{idx}] {symbol_type} {symbol_name} at "
            f"[{file_path}:{start_line}-{end_line}] ---"
        )
        results.append(f"{header}\n{preview}\n")
    return "\n".join(results)


READ_ONLY_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_code",
            "description": (
                "Search the repository using hybrid semantic and keyword retrieval with reranking. "
                "Best for finding functions, classes, concepts, or how features are implemented."
            ),
            "parameters": SearchCodeInput.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": (
                "Search exact text or regex patterns across files using ripgrep. "
                "Returns matching lines with file paths and line numbers (up to 50 matches)."
            ),
            "parameters": GrepInput.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read contents of a file with line numbers. Supports reading specific line ranges "
                "up to 400 lines per call."
            ),
            "parameters": ReadFileInput.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": (
                "List files and subdirectories in a directory path relative to repository root."
            ),
            "parameters": ListDirectoryInput.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_symbol",
            "description": (
                "Find indexed symbol definitions (classes, functions, methods) "
                "matching a given symbol name."
            ),
            "parameters": FindSymbolInput.model_json_schema(),
        },
    },
]


async def execute_tool(
    tool_name: str,
    arguments: dict[str, Any] | str,
    repo_id: str,
    repo_dir: Path,
) -> str:
    """Validate arguments and dispatch tool execution, returning a safe string result."""
    try:
        parsed_args = (
            json.loads(arguments) if isinstance(arguments, str) else dict(arguments)
        )
    except Exception as exc:
        return f"Error: Tool arguments must be valid JSON object ({exc})"

    try:
        if tool_name == "search_code":
            inp = SearchCodeInput.model_validate(parsed_args)
            return await execute_search_code(repo_id=repo_id, args=inp)
        elif tool_name == "grep":
            inp = GrepInput.model_validate(parsed_args)
            return await execute_grep(repo_dir=repo_dir, args=inp)
        elif tool_name == "read_file":
            inp = ReadFileInput.model_validate(parsed_args)
            return await execute_read_file(repo_dir=repo_dir, args=inp)
        elif tool_name == "list_directory":
            inp = ListDirectoryInput.model_validate(parsed_args)
            return await execute_list_directory(repo_dir=repo_dir, args=inp)
        elif tool_name == "find_symbol":
            inp = FindSymbolInput.model_validate(parsed_args)
            return await execute_find_symbol(repo_id=repo_id, args=inp)
        else:
            return f"Error: Unknown tool '{tool_name}'."
    except Exception as exc:
        logger.warning("Tool execution error for '%s': %s", tool_name, exc)
        return f"Error executing {tool_name}: {exc}"
