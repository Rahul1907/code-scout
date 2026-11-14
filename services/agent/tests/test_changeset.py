from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.agent.changeset import create_changeset, parse_git_diff


def test_parse_git_diff_empty():
    assert parse_git_diff("") == []
    assert parse_git_diff("   \n  ") == []


def test_parse_git_diff_modified():
    raw = """diff --git a/src/math.py b/src/math.py
index e69de29..495b0b7 100644
--- a/src/math.py
+++ b/src/math.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a + b
+    return int(a) + int(b)
"""
    files = parse_git_diff(raw)
    assert len(files) == 1
    assert files[0]["path"] == "src/math.py"
    assert files[0]["changeType"] == "modified"
    assert "return int(a) + int(b)" in files[0]["diff"]


def test_parse_git_diff_added_and_deleted():
    raw = """diff --git a/new_file.ts b/new_file.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new_file.ts
@@ -0,0 +1 @@
+export const x = 1;
diff --git a/old_file.ts b/old_file.ts
deleted file mode 100644
index e69de29..0000000
--- a/old_file.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const y = 2;
"""
    files = parse_git_diff(raw)
    assert len(files) == 2
    assert files[0]["path"] == "new_file.ts"
    assert files[0]["changeType"] == "added"
    assert files[1]["path"] == "old_file.ts"
    assert files[1]["changeType"] == "deleted"


@pytest.mark.asyncio
async def test_create_changeset_persists_to_mongo(tmp_path: Path, monkeypatch):
    mock_db = MagicMock()
    inserted = []

    def mock_insert_one(doc):
        inserted.append(doc)
        return MagicMock(inserted_id=doc["_id"])

    mock_db.__getitem__.return_value.insert_one = mock_insert_one
    monkeypatch.setattr("app.agent.changeset.get_db", lambda: mock_db)

    # Mock subprocess diff execution to return diff text
    sample_diff = """diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-old
+new
"""

    class MockProc:
        returncode = 0

        async def communicate(self):
            return sample_diff.encode("utf-8"), b""

    async def mock_subproc(*args, **kwargs):
        return MockProc()

    monkeypatch.setattr("asyncio.create_subprocess_exec", mock_subproc)

    last_test_step = {
        "inputSummary": '{"command": "pytest"}',
        "exitCode": 0,
        "stdoutTail": "1 passed",
        "stderrTail": "",
    }

    doc = await create_changeset(
        repo_id="repo-1",
        run_id="run-1",
        worktree_dir=tmp_path,
        last_test_step=last_test_step,
    )

    assert doc is not None
    assert doc["runId"] == "run-1"
    assert doc["repoId"] == "repo-1"
    assert doc["status"] == "pending_review"
    assert len(doc["files"]) == 1
    assert doc["testCommand"] == '{"command": "pytest"}'
    assert doc["testResult"]["passed"] is True
    assert doc["testResult"]["exitCode"] == 0
    assert len(inserted) == 1

