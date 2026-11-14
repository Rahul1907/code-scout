from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from evals.tasks.run_task_eval import (
    categorize_failure,
    load_tasks,
    print_summary_table,
)


def test_load_tasks():
    tasks_file = Path("evals/tasks/tasks.json")
    assert tasks_file.exists(), "tasks.json should exist"
    tasks = load_tasks(tasks_file)
    assert len(tasks) == 15, "There should be exactly 15 tasks"
    for t in tasks:
        assert "id" in t
        assert "repo" in t
        assert "instruction" in t
        assert "testCommand" in t
        assert t["repo"] in ["ts-calculator", "py-textutils", "fullstack-todo"]


def test_categorize_failure_wrong_file():
    cat = categorize_failure(
        target_file="src/calculator.mjs",
        edited_files=["README.md"],
        agent_error=None,
        agent_status="completed",
        test_exit_code=1,
        test_output="AssertionError",
    )
    assert cat == "wrong_file"


def test_categorize_failure_test_still_failing():
    cat = categorize_failure(
        target_file="src/calculator.mjs",
        edited_files=["src/calculator.mjs"],
        agent_error=None,
        agent_status="completed",
        test_exit_code=1,
        test_output="AssertionError: Expected 5 to equal 2",
    )
    assert cat == "test_still_failing"


def test_categorize_failure_timeout():
    cat = categorize_failure(
        target_file="src/calculator.mjs",
        edited_files=["src/calculator.mjs"],
        agent_error=None,
        agent_status="completed",
        test_exit_code=-1,
        test_output="Test command timed out after 90 seconds",
    )
    assert cat == "timeout"


def test_categorize_failure_tool_error():
    cat = categorize_failure(
        target_file="src/calculator.mjs",
        edited_files=[],
        agent_error="Tool edit_file raised unexpected error",
        agent_status="error",
        test_exit_code=1,
        test_output="command failed",
    )
    assert cat == "tool_error"


def test_print_summary_table_smoke(capsys):
    results = [
        {
            "taskId": "task-01",
            "repo": "ts-calculator",
            "passed": True,
            "stepCount": 4,
            "totalTokens": 1200,
            "durationSec": 8.5,
            "failureCategory": None,
        },
        {
            "taskId": "task-02",
            "repo": "ts-calculator",
            "passed": False,
            "stepCount": 2,
            "totalTokens": 600,
            "durationSec": 4.1,
            "failureCategory": "test_still_failing",
        },
    ]
    print_summary_table(
        results=results,
        pass_rate=0.5,
        avg_steps=3.0,
        avg_tokens=900.0,
        avg_duration=6.3,
        failure_counts={"test_still_failing": 1},
    )
    captured = capsys.readouterr()
    assert "CODESCOUT TASK EVALUATION RESULTS" in captured.out
    assert "task-01" in captured.out
    assert "PASS" in captured.out
    assert "FAIL" in captured.out
