#!/usr/bin/env python3
"""Task Evaluation Suite for CodeScout

Evaluates the CodeScout coding agent in 'edit' mode against a suite of 15 concrete
software engineering tasks across 3 fixture repositories (Node/TS, Python, mixed).

For each task:
  1. Sets up an isolated git worktree for the fixture repository.
  2. Runs the agent loop in 'edit' mode to solve the task.
  3. Executes the task's independent testCommand against the worktree.
  4. Records pass/fail status, step counts, token usage, duration, and failure categorization.
  5. Cleans up the worktree.

Metrics:
  - passRate: percentage of tasks where testCommand exits with code 0.
  - avgSteps: mean number of ReAct loop steps per task.
  - avgTokens: mean prompt + completion tokens used.
  - avgDurationSec: mean wall-clock duration in seconds.
  - failureCategories: breakdown of failures (wrong_file, test_still_failing, timeout, tool_error).

Stores results in the `eval_runs` MongoDB collection under suite='task'.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from bson import ObjectId

# Ensure agent app package is importable both inside Docker (/app) and on host
current_dir = Path(__file__).resolve().parent
repo_root = current_dir.parent.parent
for candidate in [Path("/app"), repo_root / "services" / "agent", repo_root]:
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app.agent.loop import run_agent_loop  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db.mongo import get_db  # noqa: E402
from app.sandbox.manager import SandboxManager  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("eval_tasks")


def load_tasks(tasks_path: Path) -> list[dict[str, Any]]:
    """Load task specifications from JSON file."""
    if not tasks_path.exists():
        raise FileNotFoundError(f"Tasks file not found: {tasks_path}")
    with open(tasks_path, encoding="utf-8") as f:
        return json.load(f)


def prepare_fixture_repo(fixture_name: str, fixtures_dir: Path, repos_dir: str) -> str:
    """Ensure a fixture repo is initialized and available in repos_dir as a base repository.

    Returns the repo_id (e.g. 'fixture_ts-calculator').
    """
    repo_id = f"eval-fixture-{fixture_name}"
    target_base = Path(repos_dir) / repo_id / "base"
    src_fixture = fixtures_dir / fixture_name

    if not src_fixture.exists():
        raise FileNotFoundError(f"Fixture directory not found: {src_fixture}")

    # Ensure target_base exists with git repo initialized
    if not (target_base / ".git").exists():
        target_base.parent.mkdir(parents=True, exist_ok=True)
        if target_base.exists():
            shutil.rmtree(target_base)
        shutil.copytree(src_fixture, target_base)
        logger.info("Copied fixture '%s' to '%s'", fixture_name, target_base)

        import subprocess
        subprocess.run(["git", "-C", str(target_base), "init"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(target_base), "config", "user.name", "CodeScout"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(target_base), "config", "user.email", "agent@codescout.local"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(target_base), "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(target_base), "commit", "-m", "initial commit"], check=True, capture_output=True)
        logger.info("Initialized git repository for fixture at '%s'", target_base)

    # Register in Mongo repos collection if not present
    db = get_db()
    existing = db["repos"].find_one({"fullName": f"evals/{fixture_name}"})
    if not existing:
        db["repos"].insert_one(
            {
                "_id": ObjectId(),
                "repoId": repo_id,
                "owner": "evals",
                "name": fixture_name,
                "fullName": f"evals/{fixture_name}",
                "defaultBranch": "master",
                "status": "ready",
                "createdAt": datetime.now(UTC),
            }
        )

    return repo_id


async def run_independent_test(
    sandbox_mgr: SandboxManager,
    repo_id: str,
    run_id: str,
    worktree_path: str,
    test_command: str,
) -> tuple[int, str]:
    """Execute test command independently inside the sandbox container with fallback."""
    logger.info("Running independent test: '%s' for run '%s'", test_command, run_id)
    try:
        cmd_result = await sandbox_mgr.run_command(
            repo_id=repo_id,
            run_id=run_id,
            command=test_command,
            timeout_seconds=90,
        )
        output = (cmd_result.stdout + "\n" + cmd_result.stderr).strip()
        exit_code = cmd_result.exit_code
        if cmd_result.timed_out:
            exit_code = -1
            output += "\nTest command timed out after 90 seconds"
        return exit_code, output
    except Exception as exc:
        logger.warning("Sandbox run_command failed (%s), attempting local subprocess fallback...", exc)
        try:
            proc = await asyncio.create_subprocess_shell(
                test_command,
                cwd=worktree_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=90.0)
            output = (stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")).strip()
            return proc.returncode or 0, output
        except Exception as local_exc:
            return -1, f"Failed to execute test: {local_exc}"


def categorize_failure(
    target_file: str | None,
    edited_files: list[str],
    agent_error: str | None,
    agent_status: str,
    test_exit_code: int,
    test_output: str,
) -> str:
    """Categorize a failed task into one of the standardized failure buckets."""
    if agent_status == "error" or agent_error:
        if "timeout" in (agent_error or "").lower():
            return "timeout"
        return "tool_error"
    if test_exit_code == -1 or "timed out" in test_output.lower():
        return "timeout"
    if target_file:
        normalized_target = target_file.replace("\\", "/").lstrip("/")
        normalized_edited = [f.replace("\\", "/").lstrip("/") for f in edited_files]
        if normalized_target not in normalized_edited and not any(normalized_target.endswith(e) for e in normalized_edited):
            return "wrong_file"
    return "test_still_failing"


async def evaluate_task(
    task: dict[str, Any],
    sandbox_mgr: SandboxManager,
    repo_id: str,
    dry_run: bool = False,
    mock_success: bool = False,
) -> dict[str, Any]:
    """Evaluate a single task and return its detailed metrics."""
    task_id = task["id"]
    repo_name = task["repo"]
    instruction = task["instruction"]
    test_command = task["testCommand"]
    target_file = task.get("targetFile")

    run_id = f"eval-{task_id}-{int(time.time())}"
    worktree_path = await sandbox_mgr.create_worktree(repo_id, run_id)

    step_count = 0
    total_tokens = 0
    agent_status = "completed"
    agent_error: str | None = None
    edited_files: list[str] = []
    started_at = time.perf_counter()

    try:
        if dry_run:
            # Baseline test without edits: tests should initially fail
            logger.info("[%s] Dry-run: checking initial fixture state...", task_id)
        elif mock_success:
            # In mock mode, pretend the agent completed and edited the target file
            step_count = 3
            total_tokens = 1500
            edited_files = [target_file] if target_file else []
            # Make a tiny harmless comment change to target file to simulate edit
            if target_file and os.path.exists(os.path.join(worktree_path, target_file)):
                file_path = os.path.join(worktree_path, target_file)
                with open(file_path, "a", encoding="utf-8") as f:
                    f.write("\n# eval simulated edit\n")
        else:
            # Run the real agent loop in edit mode
            logger.info("[%s] Running agent loop in edit mode...", task_id)
            async for event_line in run_agent_loop(
                run_id=run_id,
                repo_id=repo_id,
                instruction=instruction,
                mode="edit",
            ):
                if event_line.startswith("event: step_completed"):
                    step_count += 1
                elif event_line.startswith("event: changeset_ready"):
                    try:
                        data_part = event_line.split("data: ", 1)[1]
                        data = json.loads(data_part)
                        edited_files = [f["path"] for f in data.get("files", [])]
                    except Exception:
                        pass
                elif event_line.startswith("event: run_completed"):
                    try:
                        data_part = event_line.split("data: ", 1)[1]
                        data = json.loads(data_part)
                        totals = data.get("totals", {})
                        total_tokens = totals.get("tokensIn", 0) + totals.get("tokensOut", 0)
                    except Exception:
                        pass
                elif event_line.startswith("event: error"):
                    try:
                        data_part = event_line.split("data: ", 1)[1]
                        data = json.loads(data_part)
                        agent_error = data.get("message")
                        agent_status = "error"
                    except Exception:
                        agent_status = "error"

        duration_sec = round(time.perf_counter() - started_at, 2)

        # Independent test verification in sandbox container
        exit_code, output = await run_independent_test(
            sandbox_mgr=sandbox_mgr,
            repo_id=repo_id,
            run_id=run_id,
            worktree_path=worktree_path,
            test_command=test_command,
        )
        passed = (exit_code == 0)

        failure_category: str | None = None
        if not passed:
            failure_category = categorize_failure(
                target_file=target_file,
                edited_files=edited_files,
                agent_error=agent_error,
                agent_status=agent_status,
                test_exit_code=exit_code,
                test_output=output,
            )

        logger.info(
            "[%s] Result: %s (exit=%d, steps=%d, tokens=%d, time=%.2fs%s)",
            task_id,
            "PASS" if passed else "FAIL",
            exit_code,
            step_count,
            total_tokens,
            duration_sec,
            f", failure={failure_category}" if failure_category else "",
        )

        return {
            "taskId": task_id,
            "repo": repo_name,
            "instruction": instruction,
            "targetFile": target_file,
            "testCommand": test_command,
            "passed": passed,
            "exitCode": exit_code,
            "testOutputTail": output[-1000:],
            "stepCount": step_count,
            "totalTokens": total_tokens,
            "durationSec": duration_sec,
            "editedFiles": edited_files,
            "failureCategory": failure_category,
            "agentStatus": agent_status,
        }

    finally:
        try:
            await sandbox_mgr.remove_worktree(repo_id, run_id)
        except Exception as cl_exc:
            logger.debug("Error cleaning up worktree: %s", cl_exc)


def print_summary_table(
    results: list[dict[str, Any]],
    pass_rate: float,
    avg_steps: float,
    avg_tokens: float,
    avg_duration: float,
    failure_counts: dict[str, int],
) -> None:
    """Print formatted ASCII summary table of task evaluation results."""
    divider = "-" * 88
    print("\n" + "=" * 88)
    print("                    CODESCOUT TASK EVALUATION RESULTS")
    print("=" * 88)
    print(f"{'Task ID':<10} | {'Repo':<15} | {'Status':<6} | {'Steps':<6} | {'Tokens':<8} | {'Duration':<9} | {'Category'}")
    print(divider)
    for r in results:
        status_str = "PASS" if r["passed"] else "FAIL"
        cat_str = r["failureCategory"] or "-"
        dur_str = f"{r['durationSec']:.1f}s"
        print(f"{r['taskId']:<10} | {r['repo']:<15} | {status_str:<6} | {r['stepCount']:<6} | {r['totalTokens']:<8} | {dur_str:<9} | {cat_str}")
    print(divider)
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    print(f"Summary: {passed}/{total} tasks passed ({pass_rate * 100:.1f}%)")
    print(f"Averages: Steps={avg_steps:.1f}, Tokens={avg_tokens:.0f}, Duration={avg_duration:.2f}s")
    print(f"Failures by category: {json.dumps(failure_counts)}")
    print("=" * 88 + "\n")


async def main() -> None:
    parser = argparse.ArgumentParser(description="Run CodeScout task evaluations.")
    parser.add_argument("--limit", type=int, default=0, help="Evaluate only first N tasks")
    parser.add_argument("--task", type=str, default="", help="Evaluate specific task by ID")
    parser.add_argument("--tasks-file", type=str, default="", help="Path to tasks.json")
    parser.add_argument("--dry-run", action="store_true", help="Run tests on initial fixtures without agent")
    parser.add_argument("--mock", action="store_true", help="Run with simulated agent success for fast verification")
    args = parser.parse_args()

    settings = get_settings()
    tasks_file = Path(args.tasks_file) if args.tasks_file else current_dir / "tasks.json"
    fixtures_dir = current_dir / "fixtures"

    tasks = load_tasks(tasks_file)
    if args.task:
        tasks = [t for t in tasks if t["id"] == args.task]
        if not tasks:
            logger.error("No task matching id '%s'", args.task)
            sys.exit(1)
    elif args.limit > 0:
        tasks = tasks[: args.limit]

    logger.info("Starting Task Evaluation on %d task(s)...", len(tasks))
    sandbox_mgr = SandboxManager()
    results: list[dict[str, Any]] = []

    # Map fixture repos to repo_ids
    fixture_repo_ids: dict[str, str] = {}

    for task in tasks:
        repo_name = task["repo"]
        if repo_name not in fixture_repo_ids:
            repo_id = prepare_fixture_repo(repo_name, fixtures_dir, settings.repos_dir)
            fixture_repo_ids[repo_name] = repo_id

        repo_id = fixture_repo_ids[repo_name]
        res = await evaluate_task(
            task=task,
            sandbox_mgr=sandbox_mgr,
            repo_id=repo_id,
            dry_run=args.dry_run,
            mock_success=args.mock,
        )
        results.append(res)

    total_tasks = len(results)
    passed_tasks = sum(1 for r in results if r["passed"])
    failed_tasks = total_tasks - passed_tasks
    pass_rate = round(passed_tasks / total_tasks, 4) if total_tasks > 0 else 0.0

    avg_steps = round(sum(r["stepCount"] for r in results) / total_tasks, 2) if total_tasks else 0.0
    avg_tokens = round(sum(r["totalTokens"] for r in results) / total_tasks, 2) if total_tasks else 0.0
    avg_duration = round(sum(r["durationSec"] for r in results) / total_tasks, 2) if total_tasks else 0.0

    failure_counts: dict[str, int] = {
        "wrong_file": 0,
        "test_still_failing": 0,
        "timeout": 0,
        "tool_error": 0,
    }
    for r in results:
        cat = r.get("failureCategory")
        if cat in failure_counts:
            failure_counts[cat] += 1
        elif cat:
            failure_counts[cat] = 1

    print_summary_table(results, pass_rate, avg_steps, avg_tokens, avg_duration, failure_counts)

    # Persist in eval_runs MongoDB collection
    db = get_db()
    eval_doc = {
        "suite": "task",
        "createdAt": datetime.now(UTC),
        "configSnapshot": {
            "llmChatModel": settings.llm_chat_model,
            "llmFastModel": settings.llm_fast_model,
            "mode": "edit",
            "dryRun": args.dry_run,
            "mock": args.mock,
        },
        "totalTasks": total_tasks,
        "passedTasks": passed_tasks,
        "failedTasks": failed_tasks,
        "metrics": {
            "passRate": pass_rate,
            "avgSteps": avg_steps,
            "avgTokens": avg_tokens,
            "avgDurationSec": avg_duration,
            "failureCategories": failure_counts,
        },
        "results": results,
    }
    inserted = db["eval_runs"].insert_one(eval_doc)
    logger.info("Saved task eval run to MongoDB 'eval_runs' (id=%s)", str(inserted.inserted_id))


if __name__ == "__main__":
    asyncio.run(main())
