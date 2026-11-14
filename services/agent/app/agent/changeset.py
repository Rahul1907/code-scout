from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from bson import ObjectId

from app.db.mongo import get_db

logger = logging.getLogger(__name__)


def parse_git_diff(raw_diff: str) -> list[dict[str, str]]:
    """Parse git unified diff output into structured per-file changes."""
    if not raw_diff.strip():
        return []

    file_diffs: list[dict[str, str]] = []
    # Split on "diff --git a/..." lines
    diff_sections = re.split(r"(?=diff --git )", raw_diff)

    for section in diff_sections:
        section = section.strip()
        if not section.startswith("diff --git"):
            continue

        lines = section.splitlines()
        first_line = lines[0]
        # diff --git a/path/to/file b/path/to/file
        match = re.search(r"diff --git a/(.+?) b/(.+)", first_line)
        if not match:
            continue

        orig_path = match.group(1)
        new_path = match.group(2)

        change_type = "modified"
        if "new file mode" in section or "--- /dev/null" in section:
            change_type = "added"
            file_path = new_path
        elif "deleted file mode" in section or "+++ /dev/null" in section:
            change_type = "deleted"
            file_path = orig_path
        else:
            file_path = new_path

        file_diffs.append(
            {
                "path": file_path,
                "changeType": change_type,
                "diff": section,
            }
        )

    return file_diffs


async def create_changeset(
    repo_id: str,
    run_id: str,
    worktree_dir: Path,
    last_test_step: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Generate per-file diffs, extract last test result, and save changeset to MongoDB."""
    # Stage newly created untracked files with intent-to-add so git diff includes them
    try:
        add_proc = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            str(worktree_dir),
            "add",
            "-N",
            ".",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await add_proc.communicate()
    except Exception as e:
        logger.debug("git add -N error: %s", e)

    proc = await asyncio.create_subprocess_exec(
        "git",
        "-C",
        str(worktree_dir),
        "diff",
        "HEAD",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    diff_text = stdout.decode("utf-8", errors="replace")
    if proc.returncode != 0 or not diff_text.strip():
        # Fallback diff without HEAD
        proc2 = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            str(worktree_dir),
            "diff",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout2, _ = await proc2.communicate()
        diff_text = stdout2.decode("utf-8", errors="replace")

    files = parse_git_diff(diff_text)
    if not files:
        logger.info("No file changes detected for run %s, skipping changeset creation", run_id)
        return None

    # Extract test information from last test step
    test_command: str | None = None
    test_result: dict[str, Any] | None = None

    if last_test_step:
        test_command = last_test_step.get("inputSummary")
        exit_code = last_test_step.get("exitCode", 0)
        stdout_tail = last_test_step.get("stdoutTail", "")
        stderr_tail = last_test_step.get("stderrTail", "")
        test_result = {
            "exitCode": exit_code,
            "stdoutTail": stdout_tail,
            "stderrTail": stderr_tail,
            "passed": (exit_code == 0),
        }

    changeset_id = str(ObjectId())
    changeset_doc = {
        "_id": changeset_id,
        "runId": run_id,
        "repoId": repo_id,
        "files": files,
        "testCommand": test_command,
        "testResult": test_result,
        "status": "pending_review",
        "createdAt": datetime.now(UTC),
    }

    db = get_db()
    await asyncio.to_thread(db["changesets"].insert_one, changeset_doc)
    logger.info(
        "Created changeset %s for run %s with %d changed files",
        changeset_id,
        run_id,
        len(files),
    )
    return changeset_doc
