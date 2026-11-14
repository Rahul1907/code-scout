from __future__ import annotations

import logging
from typing import Any

from app.config import get_settings
from app.llm import get_llm_client

logger = logging.getLogger(__name__)


async def compact_conversation_history(
    history: list[dict[str, Any]],
    keep_recent: int = 6,
) -> tuple[str | None, list[dict[str, Any]]]:
    """Keep the last `keep_recent` messages verbatim, and summarize older ones with LLM_FAST_MODEL.

    Returns (summary_of_older_messages, verbatim_recent_messages).
    """
    if len(history) <= keep_recent:
        return None, history

    older_messages = history[:-keep_recent]
    recent_messages = history[-keep_recent:]

    settings = get_settings()
    llm = get_llm_client()

    formatted_older: list[str] = []
    for msg in older_messages:
        role = msg.get("role", "unknown")
        content = str(msg.get("content", "")).strip()
        if content:
            formatted_older.append(f"{role.upper()}: {content}")

    if not formatted_older:
        return None, recent_messages

    prompt = (
        "You are an AI assistant summarizing prior conversation turns between a user and a "
        "code assistant.\n"
        "Provide a concise summary (under 150 words) capturing the main questions asked, "
        "code files/topics investigated, and key conclusions reached.\n\n"
        "Prior conversation:\n"
        + "\n\n".join(formatted_older)
        + "\n\nSummary:"
    )

    try:
        model = settings.llm_fast_model or settings.llm_chat_model
        res = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            stream=False,
            temperature=0.0,
            max_tokens=250,
        )
        summary = res.content.strip()
        if summary:
            return summary, recent_messages
    except Exception as exc:
        logger.warning("Conversation history summarization failed: %s", exc)

    # Fallback if summarization fails: brief synthetic snippet
    fallback_summary = (
        f"Earlier conversation discussed {len(older_messages)} turns about the repository."
    )
    return fallback_summary, recent_messages
