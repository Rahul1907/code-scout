import subprocess
from pathlib import Path

import pytest

from app.agent.tools import (
    ALL_TOOLS,
    WRITE_TOOLS,
    CreateFileInput,
    DeleteFileInput,
    EditFileInput,
    RunCommandInput,
    execute_create_file,
    execute_delete_file,
    execute_edit_file,
    execute_get_diff,
    execute_run_command,
    execute_tool,
)
from app.sandbox.models import CommandResult


@pytest.fixture
def temp_repo(tmp_path: Path):
    # Initialize a temporary git repository for testing
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    subprocess.run(["git", "init"], cwd=repo_dir, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@test.local"],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )

    test_file = repo_dir / "app.py"
    test_file.write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo_dir, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "initial commit"],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )
    return repo_dir


@pytest.mark.asyncio
async def test_edit_file_success(temp_repo: Path):
    args = EditFileInput(
        path="app.py",
        old_text="return a + b",
        new_text="return int(a) + int(b)",
    )
    result = await execute_edit_file(temp_repo, args)
    assert "Successfully updated 'app.py'" in result
    content = (temp_repo / "app.py").read_text()
    assert "return int(a) + int(b)" in content


@pytest.mark.asyncio
async def test_edit_file_not_found(temp_repo: Path):
    args = EditFileInput(
        path="app.py",
        old_text="non_existent_code()",
        new_text="new_code()",
    )
    result = await execute_edit_file(temp_repo, args)
    assert "Error: old_text not found in 'app.py'" in result


@pytest.mark.asyncio
async def test_edit_file_multiple_matches(temp_repo: Path):
    test_file = temp_repo / "multi.py"
    test_file.write_text("x = 1\nx = 1\n", encoding="utf-8")
    args = EditFileInput(
        path="multi.py",
        old_text="x = 1",
        new_text="x = 2",
    )
    result = await execute_edit_file(temp_repo, args)
    assert "Error: old_text found 2 times in 'multi.py'" in result


@pytest.mark.asyncio
async def test_edit_file_path_traversal(temp_repo: Path):
    args = EditFileInput(
        path="../outside.py",
        old_text="foo",
        new_text="bar",
    )
    result = await execute_edit_file(temp_repo, args)
    assert "Error: Access denied: path traversal" in result


@pytest.mark.asyncio
async def test_create_file_and_diff(temp_repo: Path):
    args = CreateFileInput(
        path="src/utils/math.py",
        content="def multiply(x, y):\n    return x * y\n",
    )
    result = await execute_create_file(temp_repo, args)
    assert "Successfully created 'src/utils/math.py'" in result
    assert (temp_repo / "src/utils/math.py").exists()

    diff = await execute_get_diff(temp_repo)
    assert "src/utils/math.py" in diff
    assert "def multiply(x, y):" in diff


@pytest.mark.asyncio
async def test_delete_file(temp_repo: Path):
    args = DeleteFileInput(path="app.py")
    result = await execute_delete_file(temp_repo, args)
    assert "Successfully deleted 'app.py'" in result
    assert not (temp_repo / "app.py").exists()

    # Deleting non-existent file
    result2 = await execute_delete_file(temp_repo, args)
    assert "Error: File 'app.py' does not exist" in result2


@pytest.mark.asyncio
async def test_execute_run_command_mocked():
    class MockSandboxManager:
        async def run_command(self, repo_id, run_id, command, install=False):
            return CommandResult(
                exit_code=0,
                stdout="test stdout\n",
                stderr="",
                duration_ms=150,
                timed_out=False,
            )

    res = await execute_run_command(
        sandbox_manager=MockSandboxManager(),
        repo_id="test-repo",
        run_id="run-1",
        args=RunCommandInput(command="pytest"),
    )
    assert "Exit code: 0" in res
    assert "150ms" in res
    assert "[stdout]\ntest stdout" in res


@pytest.mark.asyncio
async def test_execute_tool_dispatch_write_tools(temp_repo: Path):
    # Test edit_file dispatch
    edit_res = await execute_tool(
        tool_name="edit_file",
        arguments={
            "path": "app.py",
            "old_text": "return a + b",
            "new_text": "return a * b",
        },
        repo_id="repo-1",
        repo_dir=temp_repo,
    )
    assert "Successfully updated 'app.py'" in edit_res

    # Test get_diff dispatch
    diff_res = await execute_tool(
        tool_name="get_diff",
        arguments={},
        repo_id="repo-1",
        repo_dir=temp_repo,
    )
    assert "return a * b" in diff_res

    # Check tools list counts
    assert len(WRITE_TOOLS) == 5
    assert len(ALL_TOOLS) == 10
