import asyncio
from unittest.mock import AsyncMock, patch
import pytest
from app.agent.pr import generate_pr_content


@pytest.mark.asyncio
async def test_generate_pr_content_fallback():
    instruction = "Fix authentication middleware to catch expired JWTs"
    files = [
        {"path": "services/api/src/middleware/auth.ts", "changeType": "modified"},
    ]
    test_result = {"passed": True, "exitCode": 0}
    test_command = "pnpm test"

    with patch("app.agent.pr.get_llm_client") as mock_get_llm:
        mock_llm = AsyncMock()
        mock_llm.chat.side_effect = RuntimeError("LLM unavailable in test")
        mock_get_llm.return_value = mock_llm

        res = await generate_pr_content(
            instruction=instruction,
            files=files,
            test_result=test_result,
            test_command=test_command,
            run_id="run-123",
        )

        assert "Fix authentication middleware" in res["title"]
        assert "## Summary" in res["body"]
        assert "auth.ts" in res["body"]
        assert "Passed" in res["body"]
        assert "run-123" in res["body"]


@pytest.mark.asyncio
async def test_generate_pr_content_llm_success():
    instruction = "Update README with sandbox documentation"
    files = [{"path": "README.md", "changeType": "modified"}]

    with patch("app.agent.pr.get_llm_client") as mock_get_llm:
        mock_llm = AsyncMock()
        mock_resp = AsyncMock()
        mock_resp.content = '{"title": "docs: document sandbox capabilities", "body": "## Summary\\nAdded sandbox docs"}'
        mock_llm.chat.return_value = mock_resp
        mock_get_llm.return_value = mock_llm

        res = await generate_pr_content(
            instruction=instruction,
            files=files,
            run_id="run-456",
        )

        assert res["title"] == "docs: document sandbox capabilities"
        assert res["body"] == "## Summary\nAdded sandbox docs"


@pytest.mark.asyncio
async def test_commit_and_push_local(tmp_path):
    from app.sandbox.manager import SandboxManager

    # Setup a local git repo to act as worktree
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    async def run_git(*args):
        p = await asyncio.create_subprocess_exec(
            "git", "-C", str(repo_dir), *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await p.communicate()

    await run_git("init")
    await run_git("config", "user.name", "Test Agent")
    await run_git("config", "user.email", "test@test.local")
    
    file_path = repo_dir / "test.txt"
    file_path.write_text("hello")
    await run_git("add", "test.txt")
    await run_git("commit", "-m", "initial")

    # Modify file
    file_path.write_text("hello world")

    mgr = SandboxManager()
    with patch.object(mgr, "get_worktree_path", return_value=str(repo_dir)):
        result = await mgr.commit_and_push(
            repo_id="test-repo",
            run_id="run-789",
            commit_message="feat: updated test file",
        )

        assert result["committed"] is True
        assert result["branch"] == "agent/run-789"
        assert result["commitSha"]
        assert result["pushed"] is False

