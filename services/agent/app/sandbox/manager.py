import asyncio
import logging
import os
import re
import shutil
import time
from typing import Any

from app.config import get_settings
from app.sandbox.docker import DockerClient, parse_memory_bytes
from app.sandbox.models import CommandResult

logger = logging.getLogger(__name__)

DANGEROUS_COMMAND_PATTERNS = [
    re.compile(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+([/~]|\.\./|\*)"),
    re.compile(r"\bmkfs\b"),
    re.compile(r"\bdd\s+if="),
    re.compile(r"\b(curl|wget)\b.*\|\s*(bash|sh|zsh)"),
    re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),
    re.compile(r"\bchmod\s+-R\s+777\s+/"),
]


class DangerousCommandError(Exception):
    pass


def validate_command(command: str) -> None:
    """Check command against dangerous patterns."""
    for pattern in DANGEROUS_COMMAND_PATTERNS:
        if pattern.search(command):
            raise DangerousCommandError(
                "Command blocked for security reasons: "
                f"dangerous command pattern detected in '{command}'"
            )


class SandboxManager:
    """Manages git worktrees and sandboxed Docker container lifecycles per agent run."""

    def __init__(self, docker_client: DockerClient | None = None):
        self.settings = get_settings()
        self.docker_client = docker_client or DockerClient(base_url=self.settings.docker_host)
        self._active_containers: dict[str, str] = {}  # run_id -> container_id

    def get_base_repo_path(self, repo_id: str) -> str:
        return os.path.join(self.settings.repos_dir, repo_id, "base")

    def get_worktree_path(self, repo_id: str, run_id: str) -> str:
        return os.path.join(self.settings.repos_dir, repo_id, "runs", run_id)

    def get_host_worktree_path(self, repo_id: str, run_id: str) -> str:
        return f"{self.settings.repos_volume_host_path.rstrip('/')}/{repo_id}/runs/{run_id}"

    async def create_worktree(self, repo_id: str, run_id: str) -> str:
        """Create git worktree for a run at /data/repos/{repoId}/runs/{runId}."""
        base_repo = self.get_base_repo_path(repo_id)
        runs_dir = os.path.join(self.settings.repos_dir, repo_id, "runs")
        worktree_path = self.get_worktree_path(repo_id, run_id)

        os.makedirs(runs_dir, exist_ok=True)

        if os.path.exists(worktree_path):
            await self.remove_worktree(repo_id, run_id, keep_branch=False)

        cmd = [
            "git",
            "-C",
            base_repo,
            "worktree",
            "add",
            "-B",
            f"agent/{run_id}",
            worktree_path,
            "HEAD",
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(
                f"Failed to create git worktree: {stderr.decode('utf-8', errors='replace')}"
            )

        # Configure local git user for the worktree
        for config_key, config_val in [
            ("user.name", "CodeScout Agent"),
            ("user.email", "agent@codescout.local"),
        ]:
            c_proc = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                worktree_path,
                "config",
                config_key,
                config_val,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await c_proc.communicate()

        return worktree_path

    async def remove_worktree(self, repo_id: str, run_id: str, keep_branch: bool = False) -> None:
        """Remove worktree and optionally prune branch."""
        base_repo = self.get_base_repo_path(repo_id)
        worktree_path = self.get_worktree_path(repo_id, run_id)

        if os.path.exists(base_repo):
            proc = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                base_repo,
                "worktree",
                "remove",
                "--force",
                worktree_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()

            prune_proc = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                base_repo,
                "worktree",
                "prune",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await prune_proc.communicate()

            if not keep_branch:
                b_proc = await asyncio.create_subprocess_exec(
                    "git",
                    "-C",
                    base_repo,
                    "branch",
                    "-D",
                    f"agent/{run_id}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await b_proc.communicate()

        if os.path.exists(worktree_path):
            shutil.rmtree(worktree_path, ignore_errors=True)

    async def ensure_sandbox(self, repo_id: str, run_id: str) -> str:
        """Ensure the sandboxed container is running for the given run."""
        if run_id in self._active_containers:
            return self._active_containers[run_id]

        worktree_path = self.get_worktree_path(repo_id, run_id)
        if not os.path.exists(worktree_path):
            await self.create_worktree(repo_id, run_id)

        container_name = f"sandbox-{run_id}"
        host_worktree_path = self.get_host_worktree_path(repo_id, run_id)
        binds = [f"{host_worktree_path}:/workspace:rw"]

        mem_bytes = parse_memory_bytes(self.settings.sandbox_memory)
        nano_cpus = int(self.settings.sandbox_cpus * 1_000_000_000)

        container_id = await self.docker_client.create_container(
            name=container_name,
            image=self.settings.sandbox_image,
            binds=binds,
            network_disabled=True,
            network_mode="none",
            memory_bytes=mem_bytes,
            nano_cpus=nano_cpus,
            pids_limit=256,
            user="sandbox",
            working_dir="/workspace",
        )
        await self.docker_client.start_container(container_id)
        self._active_containers[run_id] = container_id
        return container_id

    async def run_command(
        self,
        repo_id: str,
        run_id: str,
        command: str,
        install: bool = False,
        timeout_seconds: int | None = None,
    ) -> CommandResult:
        """Run a command inside the sandbox.

        If install=True, runs in an ephemeral container with network access and install timeout.
        If install=False, runs in the isolated zero-network container.
        """
        validate_command(command)

        start_time = time.time()
        mem_bytes = parse_memory_bytes(self.settings.sandbox_memory)
        nano_cpus = int(self.settings.sandbox_cpus * 1_000_000_000)
        host_worktree_path = self.get_host_worktree_path(repo_id, run_id)
        binds = [f"{host_worktree_path}:/workspace:rw"]

        # Ensure worktree exists
        worktree_path = self.get_worktree_path(repo_id, run_id)
        if not os.path.exists(worktree_path):
            await self.create_worktree(repo_id, run_id)

        if install:
            # Ephemeral container with bridge network for dependency installation
            install_timeout = timeout_seconds or 180
            ephemeral_name = f"sandbox-install-{run_id}-{int(time.time() * 1000)}"
            container_id = await self.docker_client.create_container(
                name=ephemeral_name,
                image=self.settings.sandbox_image,
                binds=binds,
                network_disabled=False,
                network_mode="bridge",
                memory_bytes=mem_bytes,
                nano_cpus=nano_cpus,
                pids_limit=256,
                user="sandbox",
                working_dir="/workspace",
            )
            try:
                await self.docker_client.start_container(container_id)
                exit_code, stdout, stderr, timed_out = await self.docker_client.exec_command(
                    container_id=container_id,
                    command=command,
                    timeout_seconds=install_timeout,
                    user="sandbox",
                    working_dir="/workspace",
                )
            finally:
                await self.docker_client.stop_container(container_id, timeout=1)
                await self.docker_client.remove_container(container_id, force=True)
        else:
            # Standard isolated execution in zero-network container
            cmd_timeout = timeout_seconds or self.settings.sandbox_timeout_seconds
            container_id = await self.ensure_sandbox(repo_id, run_id)
            exit_code, stdout, stderr, timed_out = await self.docker_client.exec_command(
                container_id=container_id,
                command=command,
                timeout_seconds=cmd_timeout,
                user="sandbox",
                working_dir="/workspace",
            )

        duration_ms = int((time.time() - start_time) * 1000)
        return CommandResult(
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
            timed_out=timed_out,
        )

    async def stop_sandbox(self, run_id: str) -> None:
        """Stop and remove sandbox container for a run."""
        container_id = self._active_containers.pop(run_id, None)
        container_name = f"sandbox-{run_id}"
        target = container_id or container_name
        await self.docker_client.stop_container(target, timeout=2)
        await self.docker_client.remove_container(target, force=True)

    async def cleanup_run(self, repo_id: str, run_id: str, keep_branch: bool = False) -> None:
        """Stop sandbox container and remove worktree."""
        await self.stop_sandbox(run_id)
        await self.remove_worktree(repo_id, run_id, keep_branch=keep_branch)

    async def _ensure_worktree_valid(self, repo_id: str, run_id: str) -> None:
        """Ensure git worktree metadata is intact and valid relative to base repo."""
        base_repo = self.get_base_repo_path(repo_id)
        worktree_path = self.get_worktree_path(repo_id, run_id)
        if not os.path.exists(worktree_path):
            return

        # Check if worktree git is functional
        proc = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            worktree_path,
            "status",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        if proc.returncode != 0 and os.path.exists(base_repo):
            logger.info("Repairing worktree metadata for run %s...", run_id)
            meta_dir = os.path.join(base_repo, ".git", "worktrees", run_id)
            os.makedirs(meta_dir, exist_ok=True)
            with open(os.path.join(meta_dir, "gitdir"), "w", encoding="utf-8") as f:
                f.write(os.path.join(worktree_path, ".git"))
            with open(os.path.join(meta_dir, "commondir"), "w", encoding="utf-8") as f:
                f.write("../..\n")
            with open(os.path.join(meta_dir, "HEAD"), "w", encoding="utf-8") as f:
                f.write(f"ref: refs/heads/agent/{run_id}\n")

            git_file = os.path.join(worktree_path, ".git")
            with open(git_file, "w", encoding="utf-8") as f:
                f.write(f"gitdir: {meta_dir}\n")

            # Ensure branch exists in base
            b_proc = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                base_repo,
                "branch",
                "-f",
                f"agent/{run_id}",
                "HEAD",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await b_proc.communicate()

    async def commit_and_push(
        self,
        repo_id: str,
        run_id: str,
        commit_message: str,
        remote_url: str | None = None,
        branch_name: str | None = None,
    ) -> dict[str, Any]:
        """Commit worktree modifications and push to remote repository."""
        worktree_path = self.get_worktree_path(repo_id, run_id)
        if not os.path.exists(worktree_path):
            raise FileNotFoundError(f"Worktree path does not exist for run {run_id}: {worktree_path}")

        await self._ensure_worktree_valid(repo_id, run_id)

        target_branch = branch_name or f"agent/{run_id}"

        # 1. Stage all changes
        add_proc = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            worktree_path,
            "add",
            "-A",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await add_proc.communicate()

        # 2. Check status and commit if needed
        status_proc = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            worktree_path,
            "status",
            "--porcelain",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        s_out, _ = await status_proc.communicate()
        has_changes = bool(s_out.strip())

        if has_changes:
            commit_proc = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                worktree_path,
                "commit",
                "-m",
                commit_message,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            c_out, c_err = await commit_proc.communicate()
            if commit_proc.returncode != 0:
                logger.warning(
                    "git commit error for run %s: %s",
                    run_id,
                    c_err.decode("utf-8", errors="replace"),
                )

        # 3. Retrieve HEAD commit SHA
        rev_proc = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            worktree_path,
            "rev-parse",
            "HEAD",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        r_out, _ = await rev_proc.communicate()
        commit_sha = r_out.decode("utf-8", errors="replace").strip()

        # 4. Push to remote if specified
        pushed = False
        if remote_url:
            push_proc = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                worktree_path,
                "push",
                "--force",
                remote_url,
                f"HEAD:refs/heads/{target_branch}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            p_out, p_err = await push_proc.communicate()
            if push_proc.returncode != 0:
                err_msg = p_err.decode("utf-8", errors="replace")
                logger.error("git push failed for run %s: %s", run_id, err_msg)
                raise RuntimeError(f"Git push failed: {err_msg}")
            pushed = True

        return {
            "committed": True,
            "commitSha": commit_sha,
            "branch": target_branch,
            "pushed": pushed,
        }
