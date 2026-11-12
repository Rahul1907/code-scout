from pathlib import Path

import pathspec

MAX_FILE_BYTES = 500 * 1024

SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "dist",
        "build",
        ".next",
        "vendor",
        "__pycache__",
        ".venv",
        "venv",
        ".pytest_cache",
        ".ruff_cache",
        "coverage",
    }
)

SKIP_FILENAMES = frozenset(
    {
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "bun.lock",
        "uv.lock",
        "poetry.lock",
        "Cargo.lock",
        "Gemfile.lock",
        "composer.lock",
        "go.sum",
        "Podfile.lock",
    }
)

SKIP_EXTENSIONS = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".ico",
        ".bmp",
        ".tiff",
        ".pdf",
        ".zip",
        ".tar",
        ".gz",
        ".bz2",
        ".7z",
        ".rar",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".eot",
        ".mp3",
        ".mp4",
        ".wav",
        ".webm",
        ".mov",
        ".exe",
        ".dll",
        ".so",
        ".dylib",
        ".bin",
        ".wasm",
        ".pyc",
        ".pyo",
        ".class",
        ".jar",
        ".db",
        ".sqlite",
        ".sqlite3",
        ".map",
    }
)


def _is_minified_name(filename: str) -> bool:
    lower = filename.lower()
    return (
        lower.endswith(".min.js")
        or lower.endswith(".min.css")
        or lower.endswith(".bundle.js")
        or lower.endswith(".min.mjs")
    )


def _is_binary_file(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            sample = fh.read(8192)
    except OSError:
        return True
    if b"\x00" in sample:
        return True
    try:
        path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return True
    return False


def _load_gitignore(directory: Path) -> pathspec.PathSpec | None:
    gi = directory / ".gitignore"
    if not gi.is_file():
        return None
    try:
        lines = gi.read_text(encoding="utf-8", errors="ignore").splitlines()
        return pathspec.PathSpec.from_lines("gitignore", lines)
    except OSError:
        return None


def walk_repo_files(base_dir: Path, max_files: int = 3000) -> list[Path]:
    """Walk base_dir respecting .gitignore and always-skip rules. Returns relative Paths."""
    collected: list[Path] = []
    root_spec = _load_gitignore(base_dir)
    specs: list[tuple[Path, pathspec.PathSpec]] = []
    if root_spec is not None:
        specs.append((base_dir, root_spec))

    def _is_ignored(rel_to_root: Path, is_dir: bool) -> bool:
        for spec_dir, spec in specs:
            try:
                rel_to_spec = rel_to_root if spec_dir == base_dir else (
                    (base_dir / rel_to_root).relative_to(spec_dir)
                )
            except ValueError:
                continue
            target = rel_to_spec.as_posix() + ("/" if is_dir else "")
            if spec.match_file(target):
                return True
        return False

    def _walk(current: Path) -> None:
        if len(collected) >= max_files:
            return
        local_spec = None if current == base_dir else _load_gitignore(current)
        if local_spec is not None:
            specs.append((current, local_spec))

        try:
            entries = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name))
        except OSError:
            if local_spec is not None:
                specs.pop()
            return

        for entry in entries:
            if len(collected) >= max_files:
                break
            name = entry.name
            if entry.is_dir():
                if entry.is_symlink() or name in SKIP_DIRS:
                    continue
                rel = entry.relative_to(base_dir)
                if _is_ignored(rel, is_dir=True):
                    continue
                _walk(entry)
            elif entry.is_file():
                if entry.is_symlink():
                    continue
                if name in SKIP_FILENAMES or _is_minified_name(name):
                    continue
                if entry.suffix.lower() in SKIP_EXTENSIONS:
                    continue
                try:
                    if entry.stat().st_size > MAX_FILE_BYTES or entry.stat().st_size == 0:
                        continue
                except OSError:
                    continue
                rel = entry.relative_to(base_dir)
                if _is_ignored(rel, is_dir=False):
                    continue
                if _is_binary_file(entry):
                    continue
                collected.append(rel)

        if local_spec is not None:
            specs.pop()

    _walk(base_dir)
    return collected
