import json
import pytest
from todo_store import TodoStore


def test_add_todo_validation():
    store = TodoStore()
    item = store.add_todo("Write docs", priority="high")
    assert item.id == "1"
    assert item.title == "Write docs"
    assert item.priority == "high"

    with pytest.raises(ValueError, match="Title cannot be empty"):
        store.add_todo("")

    with pytest.raises(ValueError, match="Title cannot be empty"):
        store.add_todo("   ")


def test_complete_todo():
    store = TodoStore()
    item = store.add_todo("Fix bugs")
    assert not item.completed
    assert store.complete_todo(item.id) is True
    assert item.completed is True

    # Unknown ID should return False
    assert store.complete_todo("nonexistent-99") is False


def test_filter_todos_by_priority():
    store = TodoStore()
    t1 = store.add_todo("Low item", priority="low")
    t2 = store.add_todo("High item", priority="high")
    t3 = store.add_todo("Another high", priority="high")

    highs = store.filter_todos(priority="high")
    assert len(highs) == 2
    assert t1 not in highs
    assert t2 in highs and t3 in highs


def test_delete_todo():
    store = TodoStore()
    item = store.add_todo("To be deleted")
    assert store.delete_todo(item.id) is True
    assert store.delete_todo("nonexistent-id") is False
    assert len(store.filter_todos()) == 0


def test_export_json_includes_created_at():
    store = TodoStore()
    store.add_todo("Sample item")
    raw = store.export_json()
    data = json.loads(raw)
    assert len(data) == 1
    assert "created_at" in data[0]
    assert isinstance(data[0]["created_at"], str)
