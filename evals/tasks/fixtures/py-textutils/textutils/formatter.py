"""CodeScout Fixture: py-textutils
Text transformation and formatting utilities.
"""

from __future__ import annotations

import re


def slugify(text: str) -> str:
    """Convert text into URL-friendly slug.

    BUG: Does not lowercase, does not collapse consecutive dashes, leaves leading/trailing dashes.
    """
    clean = re.sub(r"[^\w\s-]", "", text)
    return clean.replace(" ", "-")


def truncate(text: str, max_len: int, ellipsis: str = "...") -> str:
    """Truncate text to max_len, appending ellipsis if truncated.

    BUG: Appends ellipsis after slicing to max_len, so returned string length is max_len + len(ellipsis).
    """
    if len(text) <= max_len:
        return text
    return text[:max_len] + ellipsis


def camel_to_snake(text: str) -> str:
    """Convert camelCase or PascalCase to snake_case.

    TODO: Not implemented yet.
    """
    raise NotImplementedError("camel_to_snake is not implemented")


def word_count(text: str) -> int:
    """Count words in text, ignoring punctuation-only tokens.

    BUG: Splits blindly by spaces, counting empty tokens or punctuation.
    """
    words = text.split(" ")
    return len(words)


def extract_mentions(text: str) -> list[str]:
    """Extract list of usernames mentioned like @alice or @bob_12 (without the '@').

    TODO: Not implemented yet.
    """
    raise NotImplementedError("extract_mentions is not implemented")

