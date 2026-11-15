from pathlib import Path
from unittest.mock import MagicMock, patch

from app.indexing.clone import clone_repository


def test_clone_repository_fallback_on_auth_failure(tmp_path: Path):
    # Simulate first git clone failing with 401/Username prompt, then fallback succeeding
    with patch("subprocess.run") as mock_run:
        fail_result = MagicMock(returncode=128, stderr="fatal: could not read Username", stdout="")
        success_clone = MagicMock(returncode=0, stderr="", stdout="")
        rev_parse_result = MagicMock(returncode=0, stdout="abc1234\n", stderr="")

        # Sequence:
        # 1. First clone (with token) -> fail
        # 2. Fallback clone (unauthenticated) -> success
        # 3. rev-parse HEAD -> success
        mock_run.side_effect = [fail_result, success_clone, rev_parse_result]

        base_dir, sha = clone_repository(
            repo_id="test-repo",
            clone_url="https://github.com/org/repo.git",
            token="stale_token",
            repos_dir=str(tmp_path),
        )

        assert sha == "abc1234"
        assert mock_run.call_count == 3
        # Check that the fallback call omitted the extraHeader Authorization
        fallback_call_args = mock_run.call_args_list[1][0][0]
        assert "http.extraHeader=Authorization" not in " ".join(fallback_call_args)

