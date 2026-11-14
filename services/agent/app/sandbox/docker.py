import logging
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class DockerError(Exception):
    pass


def parse_memory_bytes(mem_str: str) -> int:
    """Parse a memory string like '1g', '512m', '256k' into bytes."""
    mem_str = mem_str.strip().lower()
    match = re.match(r"^(\d+(?:\.\d+)?)\s*([kmg])?b?$", mem_str)
    if not match:
        return 1024 * 1024 * 1024  # default 1GB
    val, unit = match.groups()
    num = float(val)
    if unit == "k":
        return int(num * 1024)
    if unit == "m":
        return int(num * 1024 * 1024)
    if unit == "g":
        return int(num * 1024 * 1024 * 1024)
    return int(num)


def demux_docker_stream(data: bytes) -> tuple[str, str]:
    """Demultiplex Docker 8-byte framed stdout/stderr streams."""
    stdout_parts: list[bytes] = []
    stderr_parts: list[bytes] = []
    i = 0
    total_len = len(data)

    while i + 8 <= total_len:
        stream_type = data[i]
        padding = data[i + 1 : i + 4]
        if stream_type not in (1, 2) or padding != b"\x00\x00\x00":
            # Not a Docker framed stream header, fall back to raw text
            return data.decode("utf-8", errors="replace"), ""

        length = int.from_bytes(data[i + 4 : i + 8], byteorder="big")
        if i + 8 + length > total_len:
            return data.decode("utf-8", errors="replace"), ""

        chunk = data[i + 8 : i + 8 + length]
        if stream_type == 1:
            stdout_parts.append(chunk)
        elif stream_type == 2:
            stderr_parts.append(chunk)
        i += 8 + length

    if not stdout_parts and not stderr_parts and data:
        # Fallback if raw unmultiplexed bytes
        return data.decode("utf-8", errors="replace"), ""

    stdout_str = b"".join(stdout_parts).decode("utf-8", errors="replace")
    stderr_str = b"".join(stderr_parts).decode("utf-8", errors="replace")
    return stdout_str, stderr_str


def tail_lines(text: str, max_lines: int = 200) -> str:
    """Return at most the last max_lines lines, with a truncation notice if needed."""
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    truncated = len(lines) - max_lines
    header = f"[truncated {truncated} earlier lines]\n"
    return header + "\n".join(lines[-max_lines:])


class DockerClient:
    """Async client for interacting with Docker daemon via docker-socket-proxy."""

    def __init__(self, base_url: str = "http://docker-socket-proxy:2375"):
        self.base_url = base_url.rstrip("/")
        self._client: httpx.AsyncClient | None = None

    async def get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def create_container(
        self,
        name: str,
        image: str,
        binds: list[str],
        network_disabled: bool = True,
        network_mode: str = "none",
        memory_bytes: int = 1073741824,
        nano_cpus: int = 1000000000,
        pids_limit: int = 256,
        user: str = "sandbox",
        working_dir: str = "/workspace",
        cmd: list[str] | None = None,
    ) -> str:
        """Create a sandboxed container."""
        client = await self.get_client()
        if cmd is None:
            cmd = ["tail", "-f", "/dev/null"]

        payload: dict[str, Any] = {
            "Image": image,
            "Cmd": cmd,
            "User": user,
            "WorkingDir": working_dir,
            "NetworkDisabled": network_disabled,
            "HostConfig": {
                "Binds": binds,
                "NetworkMode": network_mode,
                "Memory": memory_bytes,
                "NanoCpus": nano_cpus,
                "PidsLimit": pids_limit,
                "Privileged": False,
                "CapDrop": ["ALL"],
                "ReadonlyRootfs": True,
                "Tmpfs": {
                    "/tmp": "rw,noexec,nosuid,size=64m",
                },
            },
        }

        res = await client.post(f"/containers/create?name={name}", json=payload)
        if res.status_code == 409:
            # Container already exists from a previous run: force remove and retry
            logger.warning("Container %s already exists, removing and recreating", name)
            await self.remove_container(name, force=True)
            res = await client.post(f"/containers/create?name={name}", json=payload)

        if res.status_code not in (200, 201):
            raise DockerError(f"Failed to create container {name}: {res.status_code} {res.text}")

        data = res.json()
        return data["Id"]

    async def start_container(self, container_id: str) -> None:
        """Start a created container."""
        client = await self.get_client()
        res = await client.post(f"/containers/{container_id}/start")
        if res.status_code not in (200, 204, 304):
            raise DockerError(
                f"Failed to start container {container_id}: {res.status_code} {res.text}"
            )

    async def exec_command(
        self,
        container_id: str,
        command: str,
        timeout_seconds: int = 120,
        user: str = "sandbox",
        working_dir: str = "/workspace",
    ) -> tuple[int, str, str, bool]:
        """Execute a command in a running container, capturing exit code, stdout, stderr.

        Returns: (exit_code, stdout_tail, stderr_tail, timed_out)
        """
        client = await self.get_client()

        # Step 1: Create exec instance
        exec_payload = {
            "AttachStdout": True,
            "AttachStderr": True,
            "Cmd": ["bash", "-c", command],
            "User": user,
            "WorkingDir": working_dir,
        }
        res = await client.post(f"/containers/{container_id}/exec", json=exec_payload)
        if res.status_code not in (200, 201):
            raise DockerError(
                f"Failed to create exec instance in {container_id}: {res.status_code} {res.text}"
            )

        exec_id = res.json()["Id"]

        # Step 2: Start exec instance and stream output
        start_payload = {"Detach": False, "Tty": False}
        timed_out = False
        raw_output = b""

        try:
            start_res = await client.post(
                f"/exec/{exec_id}/start",
                json=start_payload,
                timeout=float(timeout_seconds),
            )
            if start_res.status_code == 200:
                raw_output = start_res.content
            else:
                raw_output = start_res.text.encode("utf-8")
        except (TimeoutError, httpx.TimeoutException):
            timed_out = True
            logger.warning(
                "Exec command timed out after %ds in container %s",
                timeout_seconds,
                container_id,
            )

        stdout_raw, stderr_raw = demux_docker_stream(raw_output)

        # Step 3: Inspect exec instance for exit code
        exit_code = -1
        if not timed_out:
            try:
                inspect_res = await client.get(f"/exec/{exec_id}/json")
                if inspect_res.status_code == 200:
                    inspect_data = inspect_res.json()
                    exit_code = inspect_data.get("ExitCode", 0)
            except Exception as e:
                logger.warning("Failed to inspect exec instance %s: %s", exec_id, e)
                exit_code = 0 if not stderr_raw else 1
        else:
            stderr_raw += f"\nCommand timed out after {timeout_seconds} seconds."

        return (
            exit_code,
            tail_lines(stdout_raw, max_lines=200),
            tail_lines(stderr_raw, max_lines=200),
            timed_out,
        )

    async def stop_container(self, container_id: str, timeout: int = 2) -> None:
        """Stop a container."""
        client = await self.get_client()
        try:
            await client.post(f"/containers/{container_id}/stop?t={timeout}")
        except Exception as e:
            logger.debug("Stop container %s error (ignored): %s", container_id, e)

    async def remove_container(self, container_id: str, force: bool = True) -> None:
        """Remove a container."""
        client = await self.get_client()
        try:
            force_param = "true" if force else "false"
            res = await client.delete(f"/containers/{container_id}?force={force_param}")
            if res.status_code not in (200, 204, 404):
                logger.warning("Remove container %s returned %d", container_id, res.status_code)
        except Exception as e:
            logger.debug("Remove container %s error (ignored): %s", container_id, e)
