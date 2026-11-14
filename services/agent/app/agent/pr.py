from typing import Any
import json
import logging
from app.llm import get_llm_client

logger = logging.getLogger(__name__)

PR_SYSTEM_PROMPT = (
    "You are a senior software engineer preparing a GitHub Pull Request. "
    "Given the user instruction, modified files, diff summary, and test execution results, "
    "generate a concise PR title (under 72 chars, conventional commit format) "
    "and a comprehensive markdown body with Summary, Changes, and Verification sections. "
    "Always return valid JSON with keys 'title' and 'body'."
)


async def generate_pr_content(
    instruction: str,
    files: list[dict[str, Any]],
    test_result: dict[str, Any] | None = None,
    test_command: str | None = None,
    run_id: str | None = None,
) -> dict[str, str]:
    """Generate Pull Request title and body using LLM with fallback template."""
    files_summary = ", ".join(f"{f.get('path')} ({f.get('changeType', 'modified')})" for f in files) or "None"
    
    test_summary = "No tests executed"
    if test_result:
        passed = test_result.get("passed", False)
        code = test_result.get("exitCode", 0)
        test_summary = f"Passed (exit code {code})" if passed else f"Failed (exit code {code})"
        if test_command:
            test_summary = f"`{test_command}` - {test_summary}"

    user_prompt = (
        f"User instruction: {instruction}\n"
        f"Modified files: {files_summary}\n"
        f"Test execution: {test_summary}\n"
        f"Agent run ID: {run_id or 'unknown'}\n\n"
        "Return ONLY a JSON object: {\"title\": \"...\", \"body\": \"...\"}"
    )

    try:
        llm = get_llm_client()
        resp = await llm.chat(
            messages=[
                {"role": "system", "content": PR_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
        )

        content = resp.content.strip()
        # Clean markdown code blocks if wrapped
        if content.startswith("```"):
            lines = content.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            content = "\n".join(lines).strip()

        parsed = json.loads(content)
        if isinstance(parsed, dict) and "title" in parsed and "body" in parsed:
            return {
                "title": str(parsed["title"]).strip(),
                "body": str(parsed["body"]).strip(),
            }
    except Exception as exc:
        logger.warning("LLM PR generation failed, using fallback template: %s", exc)

    # Fallback template
    file_bullets = "\n".join(f"- `{f.get('path')}` ({f.get('changeType', 'modified')})" for f in files) or "- None"
    title_snippet = instruction.replace("\n", " ").strip()
    if len(title_snippet) > 60:
        title_snippet = title_snippet[:57] + "..."
    fallback_title = f"feat: {title_snippet}"

    body_lines = [
        "## Summary",
        instruction,
        "",
        "## Changes",
        file_bullets,
        "",
        "## Verification",
    ]
    if test_command:
        body_lines.append(f"- **Command**: `{test_command}`")
    if test_result:
        status_str = "Passed" if test_result.get("passed") else "Failed"
        body_lines.append(f"- **Status**: {status_str} (Exit code: {test_result.get('exitCode', 0)})")
    else:
        body_lines.append("- No test suite was executed in the sandbox for this run.")

    if run_id:
        body_lines.extend(["", "---", f"*Automated pull request created by CodeScout (Run ID: `{run_id}`)*"])

    return {
        "title": fallback_title,
        "body": "\n".join(body_lines),
    }
