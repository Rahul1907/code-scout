import base64
import shutil
import subprocess
from pathlib import Path


def _sanitize_error(message: str, token: str | None) -> str:
    if token:
        return message.replace(token, "***")
    return message


def clone_repository(
    repo_id: str,
    clone_url: str,
    token: str | None = None,
    repos_dir: str = "/data/repos",
) -> tuple[Path, str]:
    """Shallow-clone (depth=1) a repository to /data/repos/{repoId}/base and return (path, sha)."""
    repo_root = Path(repos_dir) / repo_id
    base_dir = repo_root / "base"

    if base_dir.exists():
        shutil.rmtree(base_dir)
    repo_root.mkdir(parents=True, exist_ok=True)

    cmd = ["git"]
    if token and clone_url.startswith("https://"):
        encoded = base64.b64encode(f"x-access-token:{token}".encode()).decode("ascii")
        cmd.extend(["-c", f"http.extraHeader=Authorization: Basic {encoded}"])
    cmd.extend(["clone", "--depth", "1", clone_url, str(base_dir)])

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        err = _sanitize_error(proc.stderr.strip() or proc.stdout.strip(), token)
        raise RuntimeError(f"git clone failed: {err}")

    sha_proc = subprocess.run(
        ["git", "-C", str(base_dir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if sha_proc.returncode != 0:
        raise RuntimeError(f"git rev-parse HEAD failed: {sha_proc.stderr.strip()}")

    return base_dir, sha_proc.stdout.strip()

