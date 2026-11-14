from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.agent.changeset import create_changeset
from app.agent.cost import estimate_cost
from app.agent.events import extract_citations, format_sse
from app.agent.prompts import AGENT_EDIT_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT
from app.agent.summarizer import compact_conversation_history
from app.agent.tools import ALL_TOOLS, READ_ONLY_TOOLS, execute_tool
from app.config import get_settings
from app.db import get_db, get_redis_client
from app.llm import ToolCall, get_llm_client
from app.sandbox import SandboxManager
from app.tracing import start_agent_trace

logger = logging.getLogger(__name__)

MAX_TOOL_OUTPUT_CHARS = 4000
DEFAULT_TOKEN_BUDGET = 50_000


def _extract_json_action(text: str) -> dict[str, Any] | None:
    """Fallback parser for models outputting ```json {"action": ..., "args": ...} ```."""
    pattern = re.compile(
        r"```(?:json)?\s*(\{\s*\"action\"\s*:\s*\"[^\"]+\".*?\})\s*```",
        re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
        if isinstance(data, dict) and "action" in data:
            return data
    except Exception:
        pass
    return None


async def run_agent_loop(
    run_id: str,
    repo_id: str,
    instruction: str,
    conversation_id: str | None = None,
    user_id: str | None = None,
    conversation_history: list[dict[str, Any]] | None = None,
    mode: str = "ask",
    max_steps_override: int | None = None,
) -> AsyncIterator[str]:
    """Execute the multi-step ReAct agent loop with read-only tools and SSE streaming."""
    started = time.perf_counter()
    settings = get_settings()
    db = get_db()
    redis_client = get_redis_client()
    llm = get_llm_client()

    sandbox_mgr: SandboxManager | None = None
    if mode == "edit":
        sandbox_mgr = SandboxManager()
        worktree_path_str = await sandbox_mgr.create_worktree(repo_id, run_id)
        repo_dir = Path(worktree_path_str)
        try:
            await sandbox_mgr.ensure_sandbox(repo_id, run_id)
        except Exception as sb_err:
            logger.warning("Could not pre-start sandbox container: %s", sb_err)
    else:
        repo_dir = Path(settings.repos_dir) / repo_id / "base"

    active_tools = ALL_TOOLS if mode == "edit" else READ_ONLY_TOOLS
    system_prompt = AGENT_EDIT_SYSTEM_PROMPT if mode == "edit" else AGENT_SYSTEM_PROMPT

    trace = start_agent_trace(
        run_id=run_id,
        repo_id=repo_id,
        instruction=instruction,
        mode=mode,
    )

    yield format_sse("run_started", {"runId": run_id})

    # Record initial agent_run document in Mongo
    initial_run_doc = {
        "runId": run_id,
        "conversationId": conversation_id,
        "repoId": repo_id,
        "userId": user_id,
        "mode": mode,
        "status": "running",
        "steps": [],
        "totals": {
            "tokensIn": 0,
            "tokensOut": 0,
            "llmCalls": 0,
            "durationMs": 0,
            "estimatedCostUsd": 0.0,
        },
        "langfuseTraceId": trace.trace_id,
        "createdAt": datetime.now(UTC),
    }
    await asyncio.to_thread(db["agent_runs"].insert_one, initial_run_doc)

    # Summarize older conversation turns if history > 6
    summary, recent_history = await compact_conversation_history(
        conversation_history or [],
        keep_recent=6,
    )

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
    ]
    if summary:
        messages.append(
            {
                "role": "system",
                "content": f"Context from earlier conversation:\n{summary}",
            }
        )

    for msg in recent_history:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)})

    messages.append({"role": "user", "content": instruction})

    step_index = 0
    total_tokens_in = 0
    total_tokens_out = 0
    total_llm_calls = 0
    recorded_steps: list[dict[str, Any]] = []
    final_answer = ""
    status = "running"
    error_message: str | None = None
    emitted_citations: set[tuple[str, int, int]] = set()
    last_test_step: dict[str, Any] | None = None

    max_steps = max_steps_override or settings.max_agent_steps
    token_budget = DEFAULT_TOKEN_BUDGET

    try:
        while step_index < max_steps:
            # 1. Check for cancellation flag in Redis
            try:
                cancelled_flag = await redis_client.get(f"run_cancelled:{run_id}")
                if cancelled_flag:
                    status = "cancelled"
                    error_message = "Agent run was cancelled by user."
                    yield format_sse("error", {"message": error_message, "retryable": False})
                    break
            except Exception as red_exc:
                logger.debug("Redis cancellation check error: %s", red_exc)

            # 2. Check token budget
            total_tokens = total_tokens_in + total_tokens_out
            if total_tokens >= token_budget:
                status = "failed"
                error_message = f"Token budget exceeded ({total_tokens} >= {token_budget})."
                yield format_sse("error", {"message": error_message, "retryable": False})
                break

            yield format_sse("step_started", {"index": step_index, "type": "thought"})

            # 3. Call LLM with active tools
            step_span = trace.start_step_span(
                step_index=step_index,
                step_type="thought",
                tool_name=None,
                input_data={"messages_count": len(messages)},
            )
            step_start = time.perf_counter()

            try:
                resp = await llm.chat(
                    messages=messages,
                    tools=active_tools,
                    temperature=0.2,
                )
                total_llm_calls += 1
                total_tokens_in += resp.usage.tokens_in
                total_tokens_out += resp.usage.tokens_out
            except Exception as llm_exc:
                logger.warning(
                    "LLM call failed at step %d: %s; retrying once", step_index, llm_exc
                )
                try:
                    resp = await llm.chat(
                        messages=messages,
                        tools=active_tools,
                        temperature=0.2,
                    )
                    total_llm_calls += 1
                    total_tokens_in += resp.usage.tokens_in
                    total_tokens_out += resp.usage.tokens_out
                except Exception as retry_exc:
                    trace.end_step_span(
                        step_span,
                        output_summary="",
                        latency_ms=(time.perf_counter() - step_start) * 1000.0,
                        error=str(retry_exc),
                    )
                    status = "failed"
                    error_message = f"LLM provider error: {retry_exc}"
                    yield format_sse("error", {"message": error_message, "retryable": True})
                    break

            summary_text = (
                resp.content[:150]
                if resp.content
                else f"{len(resp.tool_calls)} tool calls"
            )
            trace.end_step_span(
                step_span,
                output_summary=summary_text,
                latency_ms=(time.perf_counter() - step_start) * 1000.0,
                tokens_in=resp.usage.tokens_in,
                tokens_out=resp.usage.tokens_out,
            )

            # Check if model returned tool calls natively, or fallback to JSON action block
            tool_calls = list(resp.tool_calls)
            if not tool_calls and resp.content:
                json_action = _extract_json_action(resp.content)
                if json_action:
                    tool_calls = [
                        ToolCall(
                            id=f"fallback-{step_index}",
                            name=str(json_action.get("action", "")),
                            arguments=json.dumps(json_action.get("args", {})),
                        )
                    ]

            # If no tool calls -> Model provided its final answer!
            if not tool_calls:
                final_answer = resp.content.strip()
                yield format_sse("token", {"text": final_answer})

                for cit in extract_citations(final_answer):
                    key = (cit.filePath, cit.startLine, cit.endLine)
                    if key not in emitted_citations:
                        emitted_citations.add(key)
                        yield format_sse("citation", cit.model_dump())

                recorded_steps.append(
                    {
                        "index": step_index,
                        "type": "final_answer",
                        "toolName": None,
                        "inputSummary": instruction[:120],
                        "outputSummary": final_answer[:120],
                        "durationMs": round((time.perf_counter() - step_start) * 1000.0, 2),
                        "tokensIn": resp.usage.tokens_in,
                        "tokensOut": resp.usage.tokens_out,
                    }
                )
                status = "completed"
                break

            # Process tool calls
            # Add assistant message with tool calls to history
            messages.append(
                {
                    "role": "assistant",
                    "content": resp.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tc.name, "arguments": tc.arguments},
                        }
                        for tc in tool_calls
                    ],
                }
            )

            for tc in tool_calls:
                try:
                    parsed_args = (
                        json.loads(tc.arguments) if isinstance(tc.arguments, str) else tc.arguments
                    )
                except Exception:
                    parsed_args = {"raw": tc.arguments}

                yield format_sse(
                    "tool_call",
                    {
                        "index": step_index,
                        "toolName": tc.name,
                        "input": parsed_args,
                    },
                )

                tool_span = trace.start_step_span(
                    step_index=step_index,
                    step_type="tool_call",
                    tool_name=tc.name,
                    input_data=parsed_args,
                )
                tool_start = time.perf_counter()

                # Execute tool
                tool_output = await execute_tool(
                    tool_name=tc.name,
                    arguments=tc.arguments,
                    repo_id=repo_id,
                    repo_dir=repo_dir,
                    run_id=run_id,
                    sandbox_manager=sandbox_mgr,
                )
                tool_duration_ms = (time.perf_counter() - tool_start) * 1000.0

                if tc.name == "run_command":
                    last_test_step = {
                        "inputSummary": json.dumps(parsed_args)[:120],
                        "toolOutput": tool_output,
                        "exitCode": 0 if "Exit code: 0" in tool_output else 1,
                        "stdoutTail": tool_output[:500],
                        "stderrTail": "",
                    }

                # Truncate large tool output
                if len(tool_output) > MAX_TOOL_OUTPUT_CHARS:
                    trunc_note = f"\n\n[truncated: exceeded {MAX_TOOL_OUTPUT_CHARS} chars]"
                    tool_output = tool_output[:MAX_TOOL_OUTPUT_CHARS] + trunc_note

                first_line = tool_output.splitlines()[0] if tool_output else ""
                output_summary = (first_line[:120] + "...") if len(first_line) > 120 else first_line

                trace.end_step_span(
                    tool_span,
                    output_summary=output_summary,
                    latency_ms=tool_duration_ms,
                )

                yield format_sse(
                    "tool_result",
                    {
                        "index": step_index,
                        "toolName": tc.name,
                        "outputSummary": output_summary,
                        "durationMs": round(tool_duration_ms, 2),
                    },
                )

                recorded_steps.append(
                    {
                        "index": step_index,
                        "type": "tool_call",
                        "toolName": tc.name,
                        "inputSummary": json.dumps(parsed_args)[:120],
                        "outputSummary": output_summary,
                        "durationMs": round(tool_duration_ms, 2),
                        "tokensIn": resp.usage.tokens_in,
                        "tokensOut": resp.usage.tokens_out,
                    }
                )

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "name": tc.name,
                        "content": tool_output,
                    }
                )
                step_index += 1

        # If loop reached max_steps without returning a final answer, force one last synthesis
        if step_index >= max_steps and not final_answer and status == "running":
            force_prompt = (
                "You have reached the maximum allowed tool exploration steps. "
                "Synthesize your final answer now based on the information discovered so far, "
                "including all relevant inline citations in [path:startLine-endLine] format."
            )
            messages.append({"role": "user", "content": force_prompt})

            synth_start = time.perf_counter()
            synth_resp = await llm.chat(
                messages=messages,
                tools=None,
                temperature=0.2,
            )
            total_llm_calls += 1
            total_tokens_in += synth_resp.usage.tokens_in
            total_tokens_out += synth_resp.usage.tokens_out

            final_answer = synth_resp.content.strip()
            yield format_sse("token", {"text": final_answer})

            for cit in extract_citations(final_answer):
                key = (cit.filePath, cit.startLine, cit.endLine)
                if key not in emitted_citations:
                    emitted_citations.add(key)
                    yield format_sse("citation", cit.model_dump())

            recorded_steps.append(
                {
                    "index": step_index,
                    "type": "final_answer_synthesis",
                    "toolName": None,
                    "inputSummary": "Maximum steps forced synthesis",
                    "outputSummary": final_answer[:120],
                    "durationMs": round((time.perf_counter() - synth_start) * 1000.0, 2),
                    "tokensIn": synth_resp.usage.tokens_in,
                    "tokensOut": synth_resp.usage.tokens_out,
                }
            )
            status = "completed"

        # In edit mode, create changeset if file changes exist
        if status == "completed" and mode == "edit":
            try:
                changeset_doc = await create_changeset(
                    repo_id=repo_id,
                    run_id=run_id,
                    worktree_dir=repo_dir,
                    last_test_step=last_test_step,
                )
                if changeset_doc:
                    status = "awaiting_approval"
                    yield format_sse(
                        "changeset_ready",
                        {"changesetId": changeset_doc["_id"], "runId": run_id},
                    )
            except Exception as cs_err:
                logger.warning("Error creating changeset for run %s: %s", run_id, cs_err)

    except Exception as exc:
        status = "failed"
        error_message = str(exc)
        logger.exception("Agent loop unhandled exception for run '%s'", run_id)
        yield format_sse("error", {"message": error_message, "retryable": False})

    finally:
        if sandbox_mgr:
            try:
                await sandbox_mgr.stop_sandbox(run_id)
            except Exception as s_exc:
                logger.debug("Error stopping sandbox container: %s", s_exc)

        total_duration_ms = round((time.perf_counter() - started) * 1000.0, 2)
        model_name = settings.llm_chat_model
        estimated_cost = estimate_cost(model_name, total_tokens_in, total_tokens_out)

        totals = {
            "tokensIn": total_tokens_in,
            "tokensOut": total_tokens_out,
            "llmCalls": total_llm_calls,
            "durationMs": total_duration_ms,
            "estimatedCostUsd": estimated_cost,
        }

        # Update MongoDB agent_runs document
        try:
            await asyncio.to_thread(
                db["agent_runs"].update_one,
                {"runId": run_id},
                {
                    "$set": {
                        "status": status,
                        "steps": recorded_steps,
                        "totals": totals,
                        "error": error_message,
                        "completedAt": datetime.now(UTC),
                    }
                },
            )
        except Exception as db_exc:
            logger.warning("Failed to persist agent_runs document: %s", db_exc)

        # Close trace
        trace.finish(
            status=status,
            final_answer=final_answer,
            totals=totals,
            error=error_message,
        )

        yield format_sse(
            "run_completed",
            {
                "runId": run_id,
                "totals": totals,
            },
        )
