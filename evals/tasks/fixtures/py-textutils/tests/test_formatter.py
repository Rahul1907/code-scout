import pytest
from textutils.formatter import (
    camel_to_snake,
    extract_mentions,
    slugify,
    truncate,
    word_count,
)


def test_slugify():
    assert slugify("Hello World") == "hello-world"
    assert slugify("Code---Scout  Agent!") == "code-scout-agent"
    assert slugify("  Leading and Trailing  ") == "leading-and-trailing"


def test_truncate():
    assert truncate("Short", 10) == "Short"
    result = truncate("Hello World! Welcome to CodeScout", 15)
    assert len(result) == 15
    assert result == "Hello World!..."


def test_camel_to_snake():
    assert camel_to_snake("camelCase") == "camel_case"
    assert camel_to_snake("PascalCase") == "pascal_case"
    assert camel_to_snake("already_snake") == "already_snake"


def test_word_count():
    assert word_count("Hello world") == 2
    assert word_count("  Hello,   world!  --  ") == 2
    assert word_count("") == 0


def test_extract_mentions():
    assert extract_mentions("Hello @alice and @bob_99, how are you?") == ["alice", "bob_99"]
    assert extract_mentions("No mentions here.") == []
    assert extract_mentions("Contact support@example.com or @team") == ["team"]
