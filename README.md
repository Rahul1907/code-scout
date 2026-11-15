# CodeScout

AI Coding Agent for GitHub Repositories.

## Local Development

1. Copy `.env.example` to `.env` and fill in required credentials.
2. Start all services:
   ```bash
   docker compose up --build
   ```
3. Verify services:
   - Web UI: http://localhost:3000
   - API Health: http://localhost:4000/api/health

## Sandboxed Code Editing & Test Execution

CodeScout runs agent-driven file edits and test execution inside an isolated Docker sandbox
(`sandbox/Dockerfile`) rather than on the host machine.

### Security model
- **Non-root user**: the container runs as a `sandbox` user (UID/GID 1000) with `/workspace` as the working directory [sandbox/Dockerfile:25-34].
- **Dangerous command blocking**: `validate_command()` rejects commands such as `rm -rf /`, `curl ... | bash`, `wget ... | sh`, fork bombs, `chmod -R 777 /`, `mkfs`, and `dd` to block devices [services/agent/app/sandbox/manager.py:14-21].
- **Path traversal protection**: write tools reject paths that escape the repository root (e.g. `../outside.py`) [services/agent/tests/test_write_tools.py:92-99].
- **Resource limits**: containers run with network disabled by default, memory and CPU limits, a PID limit, a read-only root filesystem, dropped capabilities, and command timeouts enforced by the sandbox manager [services/agent/app/sandbox/docker.py:92-110] [services/agent/app/sandbox/manager.py:38-271].

### Capabilities
The agent exposes these sandbox tools (see `services/agent/app/agent/tools.py`):

| Tool | Purpose |
|------|---------|
| `edit_file` | Replace `old_text` with `new_text` in a file; errors on zero or multiple matches [services/agent/tests/test_write_tools.py:54-88] |
| `create_file` | Create a new file (including parent directories) [services/agent/tests/test_write_tools.py:102-110] |
| `delete_file` | Delete a file within the repository [services/agent/tests/test_write_tools.py:118-126] |
| `run_command` | Execute a command (e.g. `pytest`, `pnpm test`) inside the sandbox with output streaming [services/agent/tests/test_write_tools.py:130-149] |
| `get_diff` | Return the `git diff` of the worktree for review before approval [services/agent/tests/test_write_tools.py:112-114] |

### Running sandbox tests locally
```bash
cd services/agent
pytest tests/test_sandbox.py tests/test_write_tools.py -v
```

The sandbox test suite covers memory parsing, Docker stream demuxing, output tailing, dangerous-command rejection, safe-command allowance, file edit/create/delete, diff generation, command execution, and path-traversal blocking.

