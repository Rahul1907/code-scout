import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.llm import chat, embed  # noqa: E402


async def main() -> int:
    settings = get_settings()
    if not settings.llm_api_key:
        print("ERROR: LLM_API_KEY is empty", file=sys.stderr)
        return 1

    print(f"Testing chat with model: {settings.llm_chat_model}")
    chat_res = await chat(
        messages=[{"role": "user", "content": "Reply with the single word: pong"}],
    )
    print(
        f"Chat reply: {chat_res.content!r} | "
        f"tokens_in={chat_res.usage.tokens_in} tokens_out={chat_res.usage.tokens_out} "
        f"latency_ms={chat_res.usage.latency_ms:.1f}"
    )

    print(f"Testing embed with model: {settings.embedding_model}")
    embed_res = await embed(["def hello(): return 'world'"])
    dim = len(embed_res.embeddings[0]) if embed_res.embeddings else 0
    print(
        f"Embed vectors={len(embed_res.embeddings)} dim={dim} | "
        f"tokens_in={embed_res.usage.tokens_in} latency_ms={embed_res.usage.latency_ms:.1f}"
    )
    assert dim == settings.embedding_dimensions, (
        f"Expected embedding dimension {settings.embedding_dimensions}, got {dim}"
    )
    print("Live LLM chat and embed verification PASSED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
