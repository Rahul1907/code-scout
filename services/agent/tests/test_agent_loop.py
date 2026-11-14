from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent.loop import _extract_json_action, run_agent_loop
from app.agent.summarizer import compact_conversation_history
from app.llm.client import ChatResponse, LLMUsage, ToolCall


def test_extract_json_action() -> None:
    text = (
        "I will search for the Router symbol:\n"
        "```json\n"
        '{"action": "find_symbol", "args": {"name": "Router"}}\n'
        "```"
    )
    action = _extract_json_action(text)
    assert action is not None
    assert action["action"] == "find_symbol"
    assert action["args"]["name"] == "Router"

    assert _extract_json_action("Just answering directly.") is None


@pytest.mark.asyncio
async def test_compact_conversation_history_short() -> None:
    history = [{"role": "user", "content": f"msg {i}"} for i in range(4)]
    summary, recent = await compact_conversation_history(history, keep_recent=6)
    assert summary is None
    assert len(recent) == 4


@pytest.mark.asyncio
async def test_compact_conversation_history_long() -> None:
    history = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
    mock_llm = AsyncMock()
    mock_llm.chat = AsyncMock(
        return_value=ChatResponse(
            content="Summary: user asked about msgs 0 to 3.",
            tool_calls=[],
            usage=LLMUsage(tokens_in=20, tokens_out=10),
        )
    )

    with patch("app.agent.summarizer.get_llm_client", return_value=mock_llm):
        summary, recent = await compact_conversation_history(history, keep_recent=6)
        assert summary == "Summary: user asked about msgs 0 to 3."
        assert len(recent) == 6
        assert recent[-1]["content"] == "msg 9"


@pytest.mark.asyncio
async def test_agent_loop_normal_completion() -> None:
    mock_db = MagicMock()
    mock_db.__getitem__.return_value.insert_one = MagicMock()
    mock_db.__getitem__.return_value.update_one = MagicMock()

    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=None)

    # First turn: call read_file
    turn1 = ChatResponse(
        content="Let me read the routing file.",
        tool_calls=[
            ToolCall(
                id="call-1",
                name="read_file",
                arguments=json.dumps({"path": "routing.py", "start_line": 1, "end_line": 20}),
            )
        ],
        usage=LLMUsage(tokens_in=50, tokens_out=25),
    )
    # Second turn: final answer with citation
    turn2 = ChatResponse(
        content="Routing is defined in [routing.py:10-20].",
        tool_calls=[],
        usage=LLMUsage(tokens_in=80, tokens_out=30),
    )

    mock_llm = AsyncMock()
    mock_llm.chat = AsyncMock(side_effect=[turn1, turn2])

    with (
        patch("app.agent.loop.get_db", return_value=mock_db),
        patch("app.agent.loop.get_redis_client", return_value=mock_redis),
        patch("app.agent.loop.get_llm_client", return_value=mock_llm),
        patch("app.agent.loop.execute_tool", AsyncMock(return_value="1 | class Router:\n2 | pass")),
    ):
        events: list[str] = []
        async for chunk in run_agent_loop(
            run_id="run-test-1",
            repo_id="507f1f77bcf86cd799439011",
            instruction="Where is Router defined?",
        ):
            events.append(chunk)

    combined = "".join(events)
    assert "event: run_started" in combined
    assert "event: step_started" in combined
    assert "event: tool_call" in combined
    assert "event: tool_result" in combined
    assert "event: token" in combined
    assert "event: citation" in combined
    assert "routing.py" in combined
    assert "event: run_completed" in combined

    # Check MongoDB update was called
    assert mock_db.__getitem__.return_value.update_one.called
    update_call = mock_db.__getitem__.return_value.update_one.call_args
    assert update_call[0][0] == {"runId": "run-test-1"}
    assert update_call[0][1]["$set"]["status"] == "completed"


@pytest.mark.asyncio
async def test_agent_loop_cancellation() -> None:
    mock_db = MagicMock()
    mock_db.__getitem__.return_value.insert_one = MagicMock()
    mock_db.__getitem__.return_value.update_one = MagicMock()

    mock_redis = AsyncMock()
    # Cancelled before first step
    mock_redis.get = AsyncMock(return_value="1")

    mock_llm = AsyncMock()

    with (
        patch("app.agent.loop.get_db", return_value=mock_db),
        patch("app.agent.loop.get_redis_client", return_value=mock_redis),
        patch("app.agent.loop.get_llm_client", return_value=mock_llm),
    ):
        events: list[str] = []
        async for chunk in run_agent_loop(
            run_id="run-cancelled-1",
            repo_id="507f1f77bcf86cd799439011",
            instruction="Where is Router defined?",
        ):
            events.append(chunk)

    combined = "".join(events)
    assert "event: error" in combined
    assert "cancelled by user" in combined

    update_call = mock_db.__getitem__.return_value.update_one.call_args
    assert update_call[0][1]["$set"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_agent_loop_max_steps_reached() -> None:
    mock_db = MagicMock()
    mock_db.__getitem__.return_value.insert_one = MagicMock()
    mock_db.__getitem__.return_value.update_one = MagicMock()

    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=None)

    # Tool call every time
    looping_turn = ChatResponse(
        content="Searching more.",
        tool_calls=[
            ToolCall(
                id="call-loop",
                name="list_directory",
                arguments=json.dumps({"path": "."}),
            )
        ],
        usage=LLMUsage(tokens_in=30, tokens_out=15),
    )
    # Synthesis turn when max steps hit
    synth_turn = ChatResponse(
        content="Final answer synthesized after max steps in [app.py:1-5].",
        tool_calls=[],
        usage=LLMUsage(tokens_in=50, tokens_out=20),
    )

    mock_llm = AsyncMock()
    # 2 loop turns (max_steps=2), followed by 1 forced synthesis turn
    mock_llm.chat = AsyncMock(side_effect=[looping_turn, looping_turn, synth_turn])

    with (
        patch("app.agent.loop.get_db", return_value=mock_db),
        patch("app.agent.loop.get_redis_client", return_value=mock_redis),
        patch("app.agent.loop.get_llm_client", return_value=mock_llm),
        patch("app.agent.loop.execute_tool", AsyncMock(return_value="[file] app.py")),
    ):
        events: list[str] = []
        async for chunk in run_agent_loop(
            run_id="run-max-steps",
            repo_id="507f1f77bcf86cd799439011",
            instruction="Where is Router defined?",
            max_steps_override=2,
        ):
            events.append(chunk)

    combined = "".join(events)
    assert "event: run_started" in combined
    assert "event: token" in combined
    assert "Final answer synthesized" in combined
    assert "event: run_completed" in combined

    update_call = mock_db.__getitem__.return_value.update_one.call_args
    assert update_call[0][1]["$set"]["status"] == "completed"


@pytest.mark.asyncio
async def test_agent_loop_fallback_json_action() -> None:
    mock_db = MagicMock()
    mock_db.__getitem__.return_value.insert_one = MagicMock()
    mock_db.__getitem__.return_value.update_one = MagicMock()

    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=None)

    # Model returned JSON action in content rather than tool_calls
    fallback_turn = ChatResponse(
        content=(
            "I need to inspect the directory:\n"
            "```json\n"
            '{"action": "list_directory", "args": {"path": "."}}\n'
            "```"
        ),
        tool_calls=[],
        usage=LLMUsage(tokens_in=40, tokens_out=20),
    )
    final_turn = ChatResponse(
        content="I found the directory structure in [README.md:1-10].",
        tool_calls=[],
        usage=LLMUsage(tokens_in=60, tokens_out=25),
    )

    mock_llm = AsyncMock()
    mock_llm.chat = AsyncMock(side_effect=[fallback_turn, final_turn])

    with (
        patch("app.agent.loop.get_db", return_value=mock_db),
        patch("app.agent.loop.get_redis_client", return_value=mock_redis),
        patch("app.agent.loop.get_llm_client", return_value=mock_llm),
        patch("app.agent.loop.execute_tool", AsyncMock(return_value="[file] README.md")),
    ):
        events: list[str] = []
        async for chunk in run_agent_loop(
            run_id="run-fallback-test",
            repo_id="507f1f77bcf86cd799439011",
            instruction="List files.",
        ):
            events.append(chunk)

    combined = "".join(events)
    assert "event: tool_call" in combined
    assert '"toolName": "list_directory"' in combined
    assert "event: tool_result" in combined
    assert "event: run_completed" in combined

