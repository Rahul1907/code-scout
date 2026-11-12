import hashlib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel
from tree_sitter import Node
from tree_sitter_language_pack import get_parser

SymbolType = Literal["function", "class", "method", "module", "block"]

MAX_SYMBOL_LINES = 120
SYMBOL_OVERLAP_LINES = 15
FALLBACK_WINDOW_LINES = 60
FALLBACK_OVERLAP_LINES = 10

EXT_TO_TS_LANG: dict[str, str] = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".py": "python",
}

EXT_TO_LANG_NAME: dict[str, str] = {
    **EXT_TO_TS_LANG,
    ".json": "json",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".sh": "bash",
    ".css": "css",
    ".html": "html",
    ".sql": "sql",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".rb": "ruby",
}


class CodeChunk(BaseModel):
    file_path: str
    language: str
    symbol_name: str
    symbol_type: SymbolType
    start_line: int
    end_line: int
    content: str
    content_hash: str


def format_chunk_for_embedding(chunk: CodeChunk) -> str:
    return (
        f"File: {chunk.file_path}\n"
        f"Symbol: {chunk.symbol_type} {chunk.symbol_name}\n"
        f"{chunk.content}"
    )


def _hash_content(file_path: str, start_line: int, end_line: int, content: str) -> str:
    payload = f"{file_path}:{start_line}:{end_line}:{content}".encode()
    return hashlib.sha256(payload).hexdigest()


def _make_chunk(
    file_path: str,
    language: str,
    symbol_name: str,
    symbol_type: SymbolType,
    lines: list[str],
    start_line: int,
    end_line: int,
) -> CodeChunk:
    snippet = "\n".join(lines[start_line - 1 : end_line])
    return CodeChunk(
        file_path=file_path,
        language=language,
        symbol_name=symbol_name,
        symbol_type=symbol_type,
        start_line=start_line,
        end_line=end_line,
        content=snippet,
        content_hash=_hash_content(file_path, start_line, end_line, snippet),
    )


def _split_line_range(
    file_path: str,
    language: str,
    symbol_name: str,
    symbol_type: SymbolType,
    lines: list[str],
    start_line: int,
    end_line: int,
    max_lines: int = MAX_SYMBOL_LINES,
    overlap: int = SYMBOL_OVERLAP_LINES,
) -> list[CodeChunk]:
    total = end_line - start_line + 1
    if total <= max_lines:
        return [
            _make_chunk(
                file_path=file_path,
                language=language,
                symbol_name=symbol_name,
                symbol_type=symbol_type,
                lines=lines,
                start_line=start_line,
                end_line=end_line,
            )
        ]

    chunks: list[CodeChunk] = []
    step = max(1, max_lines - overlap)
    cur = start_line
    part = 1
    while cur <= end_line:
        chunk_end = min(end_line, cur + max_lines - 1)
        part_name = f"{symbol_name}#part{part}"
        chunks.append(
            _make_chunk(
                file_path=file_path,
                language=language,
                symbol_name=part_name,
                symbol_type=symbol_type,
                lines=lines,
                start_line=cur,
                end_line=chunk_end,
            )
        )
        if chunk_end >= end_line:
            break
        cur += step
        part += 1
    return chunks


def _node_text(node: Node, source_bytes: bytes) -> str:
    return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _extract_python_symbols(
    root: Node,
    source_bytes: bytes,
) -> list[tuple[str, SymbolType, int, int]]:
    symbols: list[tuple[str, SymbolType, int, int]] = []

    def _visit_top(node: Node) -> None:
        target = node
        if node.type == "decorated_definition":
            for child in node.children:
                if child.type in ("function_definition", "class_definition"):
                    target = child
                    break

        if target.type == "function_definition":
            name_node = target.child_by_field_name("name")
            name = _node_text(name_node, source_bytes) if name_node else "anonymous"
            symbols.append((name, "function", node.start_point[0] + 1, node.end_point[0] + 1))
        elif target.type == "class_definition":
            name_node = target.child_by_field_name("name")
            class_name = _node_text(name_node, source_bytes) if name_node else "AnonymousClass"
            body = target.child_by_field_name("body")
            methods: list[tuple[str, SymbolType, int, int]] = []
            if body is not None:
                for stmt in body.children:
                    stmt_target = stmt
                    if stmt.type == "decorated_definition":
                        for child in stmt.children:
                            if child.type == "function_definition":
                                stmt_target = child
                                break
                    if stmt_target.type == "function_definition":
                        m_name_node = stmt_target.child_by_field_name("name")
                        m_name = (
                            _node_text(m_name_node, source_bytes) if m_name_node else "anonymous"
                        )
                        methods.append(
                            (
                                f"{class_name}.{m_name}",
                                "method",
                                stmt.start_point[0] + 1,
                                stmt.end_point[0] + 1,
                            )
                        )
            class_start = node.start_point[0] + 1
            class_end = node.end_point[0] + 1
            if not methods:
                symbols.append((class_name, "class", class_start, class_end))
            else:
                first_method_start = methods[0][2]
                header_end = max(class_start, first_method_start - 1)
                symbols.append((class_name, "class", class_start, header_end))
                symbols.extend(methods)

    for child in root.children:
        if child.type in ("function_definition", "class_definition", "decorated_definition"):
            _visit_top(child)

    return symbols


def _extract_js_ts_symbols(
    root: Node,
    source_bytes: bytes,
) -> list[tuple[str, SymbolType, int, int]]:
    symbols: list[tuple[str, SymbolType, int, int]] = []

    def _extract_class(class_node: Node, outer_start: int, outer_end: int) -> None:
        name_node = class_node.child_by_field_name("name")
        class_name = _node_text(name_node, source_bytes) if name_node else "AnonymousClass"
        body = class_node.child_by_field_name("body")
        methods: list[tuple[str, SymbolType, int, int]] = []
        if body is not None:
            for member in body.children:
                if member.type == "method_definition":
                    m_name_node = member.child_by_field_name("name")
                    m_name = _node_text(m_name_node, source_bytes) if m_name_node else "anonymous"
                    methods.append(
                        (
                            f"{class_name}.{m_name}",
                            "method",
                            member.start_point[0] + 1,
                            member.end_point[0] + 1,
                        )
                    )
        if not methods:
            symbols.append((class_name, "class", outer_start, outer_end))
        else:
            first_method_start = methods[0][2]
            header_end = max(outer_start, first_method_start - 1)
            symbols.append((class_name, "class", outer_start, header_end))
            symbols.extend(methods)

    def _handle_declaration(decl: Node, outer_start: int, outer_end: int) -> None:
        if decl.type in ("function_declaration", "generator_function_declaration"):
            name_node = decl.child_by_field_name("name")
            name = _node_text(name_node, source_bytes) if name_node else "anonymous"
            symbols.append((name, "function", outer_start, outer_end))
        elif decl.type == "class_declaration":
            _extract_class(decl, outer_start, outer_end)
        elif decl.type in ("lexical_declaration", "variable_declaration"):
            for child in decl.children:
                if child.type == "variable_declarator":
                    val = child.child_by_field_name("value")
                    if val and val.type in ("arrow_function", "function_expression", "function"):
                        name_node = child.child_by_field_name("name")
                        name = _node_text(name_node, source_bytes) if name_node else "anonymous"
                        symbols.append((name, "function", outer_start, outer_end))
                        break

    for child in root.children:
        start_line = child.start_point[0] + 1
        end_line = child.end_point[0] + 1
        if child.type == "export_statement":
            decl = child.child_by_field_name("declaration")
            if decl is not None:
                _handle_declaration(decl, start_line, end_line)
            else:
                for sub in child.children:
                    if sub.type in (
                        "function_declaration",
                        "generator_function_declaration",
                        "class_declaration",
                    ):
                        _handle_declaration(sub, start_line, end_line)
                        break
        else:
            _handle_declaration(child, start_line, end_line)

    return symbols


def _group_module_blocks(
    file_path: str,
    language: str,
    lines: list[str],
    covered_ranges: list[tuple[int, int]],
) -> list[CodeChunk]:
    total_lines = len(lines)
    covered = [False] * (total_lines + 1)
    for start, end in covered_ranges:
        for idx in range(max(1, start), min(total_lines, end) + 1):
            covered[idx] = True

    chunks: list[CodeChunk] = []
    block_start: int | None = None

    def _flush(b_start: int, b_end: int) -> None:
        # Trim leading and trailing blank lines in module block
        while b_start <= b_end and not lines[b_start - 1].strip():
            b_start += 1
        while b_end >= b_start and not lines[b_end - 1].strip():
            b_end -= 1
        if b_start <= b_end:
            chunks.extend(
                _split_line_range(
                    file_path=file_path,
                    language=language,
                    symbol_name=f"module_{b_start}_{b_end}",
                    symbol_type="module",
                    lines=lines,
                    start_line=b_start,
                    end_line=b_end,
                )
            )

    for line_no in range(1, total_lines + 1):
        if not covered[line_no]:
            if block_start is None:
                block_start = line_no
        elif block_start is not None:
            _flush(block_start, line_no - 1)
            block_start = None

    if block_start is not None:
        _flush(block_start, total_lines)

    return chunks


def _chunk_fallback(file_path: str, language: str, lines: list[str]) -> list[CodeChunk]:
    total = len(lines)
    if total == 0:
        return []
    chunks: list[CodeChunk] = []
    step = max(1, FALLBACK_WINDOW_LINES - FALLBACK_OVERLAP_LINES)
    cur = 1
    while cur <= total:
        end = min(total, cur + FALLBACK_WINDOW_LINES - 1)
        snippet = "\n".join(lines[cur - 1 : end])
        if snippet.strip():
            chunks.append(
                _make_chunk(
                    file_path=file_path,
                    language=language,
                    symbol_name=f"lines_{cur}_{end}",
                    symbol_type="block",
                    lines=lines,
                    start_line=cur,
                    end_line=end,
                )
            )
        if end >= total:
            break
        cur += step
    return chunks


def chunk_file(file_path: str, content: str) -> list[CodeChunk]:
    """Chunk source code using tree-sitter (JS/TS/TSX/Python) or 60/10 line windows."""
    if not content.strip():
        return []

    lines = content.splitlines()
    ext = Path(file_path).suffix.lower()
    ts_lang = EXT_TO_TS_LANG.get(ext)
    language = EXT_TO_LANG_NAME.get(ext, ext.lstrip(".") or "text")

    if ts_lang is None:
        return _chunk_fallback(file_path, language, lines)

    parser = get_parser(ts_lang)  # type: ignore[arg-type]
    source_bytes = content.encode("utf-8")
    tree = parser.parse(source_bytes)

    if ts_lang == "python":
        symbols = _extract_python_symbols(tree.root_node, source_bytes)
    else:
        symbols = _extract_js_ts_symbols(tree.root_node, source_bytes)

    chunks: list[CodeChunk] = []
    covered_ranges: list[tuple[int, int]] = []
    for sym_name, sym_type, start_line, end_line in symbols:
        covered_ranges.append((start_line, end_line))
        chunks.extend(
            _split_line_range(
                file_path=file_path,
                language=language,
                symbol_name=sym_name,
                symbol_type=sym_type,
                lines=lines,
                start_line=start_line,
                end_line=end_line,
            )
        )

    chunks.extend(_group_module_blocks(file_path, language, lines, covered_ranges))
    chunks.sort(key=lambda c: (c.start_line, c.end_line))
    return chunks

