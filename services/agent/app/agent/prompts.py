from app.retrieval.vector import RetrievedChunk

QA_SYSTEM_PROMPT = (
    "You are CodeScout, an AI coding assistant answering questions about a GitHub repository.\n\n"
    "Rules:\n"
    "1. Answer ONLY based on the provided code excerpts. Do not guess or invent symbols, "
    "files, or behavior that are not shown.\n"
    "2. Cite every file and behavior you reference using exact inline citations in the format "
    "[path:startLine-endLine], e.g. [src/app.ts:12-34].\n"
    "3. If the provided code excerpts do not contain enough information to answer the question, "
    'explicitly say: "not found in the indexed code".\n'
    "4. Be concise, accurate, and technical."
)


def build_qa_messages(
    question: str,
    chunks: list[RetrievedChunk],
    conversation_history: list[dict[str, str]] | None = None,
) -> list[dict[str, str]]:
    context_blocks: list[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        context_blocks.append(
            f"### Excerpt {idx}: [{chunk.file_path}:{chunk.start_line}-{chunk.end_line}] "
            f"({chunk.symbol_type} {chunk.symbol_name})\n"
            f"```{chunk.language}\n{chunk.content}\n```"
        )

    context_text = (
        "\n\n".join(context_blocks)
        if context_blocks
        else "(No matching code chunks found.)"
    )

    messages: list[dict[str, str]] = [{"role": "system", "content": QA_SYSTEM_PROMPT}]
    if conversation_history:
        for msg in conversation_history[-6:]:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

    messages.append(
        {
            "role": "user",
            "content": (
                f"Code excerpts from the repository:\n\n{context_text}\n\n"
                f"Question: {question}"
            ),
        }
    )
    return messages
