from pathlib import Path

from app.indexing.chunker import chunk_file, format_chunk_for_embedding
from app.indexing.walker import walk_repo_files


def test_chunk_python_functions_classes_and_module_blocks() -> None:
    code = """import os

CONFIG = {"env": "dev"}


def helper(x: int) -> int:
    return x + 1


class Greeter:
    prefix = "Hello"

    def greet(self, name: str) -> str:
        return f"{self.prefix}, {name}"
"""
    chunks = chunk_file("src/greeter.py", code)
    by_type = {(c.symbol_type, c.symbol_name): c for c in chunks}

    assert ("function", "helper") in by_type
    assert by_type[("function", "helper")].start_line == 6
    assert by_type[("function", "helper")].end_line == 7

    assert ("class", "Greeter") in by_type
    assert ("method", "Greeter.greet") in by_type
    assert by_type[("method", "Greeter.greet")].start_line == 13
    assert by_type[("method", "Greeter.greet")].end_line == 14

    module_chunks = [c for c in chunks if c.symbol_type == "module"]
    assert len(module_chunks) >= 1
    assert "import os" in module_chunks[0].content


def test_chunk_javascript_and_typescript_and_tsx() -> None:
    js_code = """import fs from 'fs';

export function readCfg(path) {
  return fs.readFileSync(path, 'utf8');
}

const arrowFn = (a, b) => a + b;
"""
    js_chunks = chunk_file("lib/cfg.js", js_code)
    js_names = {(c.symbol_type, c.symbol_name) for c in js_chunks}
    assert ("function", "readCfg") in js_names
    assert ("function", "arrowFn") in js_names

    ts_code = """export class RepoService {
  private url: string;

  getUrl(): string {
    return this.url;
  }
}
"""
    ts_chunks = chunk_file("src/repo.ts", ts_code)
    ts_names = {(c.symbol_type, c.symbol_name) for c in ts_chunks}
    assert ("class", "RepoService") in ts_names
    assert ("method", "RepoService.getUrl") in ts_names

    tsx_code = """export function Button({ label }: { label: string }) {
  return <button type="button">{label}</button>;
}
"""
    tsx_chunks = chunk_file("components/Button.tsx", tsx_code)
    assert any(c.symbol_type == "function" and c.symbol_name == "Button" for c in tsx_chunks)


def test_chunk_splits_large_symbol_with_overlap() -> None:
    body_lines = [f"    x += {i}" for i in range(150)]
    code = "def big_func():\n    x = 0\n" + "\n".join(body_lines) + "\n    return x\n"

    chunks = chunk_file("big.py", code)
    fn_chunks = [c for c in chunks if c.symbol_type == "function"]
    assert len(fn_chunks) == 2
    assert fn_chunks[0].start_line == 1
    assert fn_chunks[0].end_line == 120
    # 15 lines overlap => second starts at 106
    assert fn_chunks[1].start_line == 106
    assert fn_chunks[1].end_line == 153


def test_chunk_fallback_text_windows_and_embedding_prefix() -> None:
    lines = [f"line {i}" for i in range(1, 76)]
    chunks = chunk_file("README.md", "\n".join(lines))

    assert len(chunks) == 2
    assert chunks[0].symbol_type == "block"
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 60
    # 60-line window with 10-line overlap => second starts at 51
    assert chunks[1].start_line == 51
    assert chunks[1].end_line == 75

    formatted = format_chunk_for_embedding(chunks[0])
    assert formatted.startswith("File: README.md\nSymbol: block lines_1_60\n")


def test_walker_respects_gitignore_and_skip_rules(tmp_path: Path) -> None:
    (tmp_path / ".gitignore").write_text("ignored.log\nsecret_dir/\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / "ignored.log").write_text("noise\n", encoding="utf-8")
    (tmp_path / "secret_dir").mkdir()
    (tmp_path / "secret_dir" / "key.txt").write_text("secret\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "pkg.js").write_text("module.exports = {}\n", encoding="utf-8")
    (tmp_path / "package-lock.json").write_text("{}\n", encoding="utf-8")
    (tmp_path / "app.min.js").write_text("console.log(1)\n", encoding="utf-8")
    (tmp_path / "binary.dat").write_bytes(b"\x00\x01\x02\x03")
    (tmp_path / "huge.txt").write_text("a" * (501 * 1024), encoding="utf-8")

    files = [p.as_posix() for p in walk_repo_files(tmp_path)]
    assert ".gitignore" in files
    assert "src/main.py" in files
    assert "ignored.log" not in files
    assert "secret_dir/key.txt" not in files
    assert "node_modules/pkg.js" not in files
    assert "package-lock.json" not in files
    assert "app.min.js" not in files
    assert "binary.dat" not in files
    assert "huge.txt" not in files

