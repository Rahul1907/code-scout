"""CodeScout Fixture: fullstack-todo
In-memory Todo Store with priority filtering and serialization.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class TodoItem:
    id: str
    title: str
    priority: str = "medium"  # low, medium, high
    completed: bool = False
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


class TodoStore:
    def __init__(self) -> None:
        self._todos: dict[str, TodoItem] = {}
        self._counter: int = 1

    def add_todo(self, title: str, priority: str = "medium") -> TodoItem:
        """Add a new todo item.

        BUG: Does not validate title (allows empty or whitespace-only strings).
        Should raise ValueError if title is empty or only whitespace.
        """
        todo_id = str(self._counter)
        self._counter += 1
        item = TodoItem(id=todo_id, title=title, priority=priority)
        self._todos[todo_id] = item
        return item

    def complete_todo(self, todo_id: str) -> bool:
        """Mark a todo as completed.

        BUG: Returns True regardless of whether the todo exists.
        Should return False if todo_id is not found in store.
        """
        if todo_id in self._todos:
            self._todos[todo_id].completed = True
        return True

    def filter_todos(
        self,
        completed: bool | None = None,
        priority: str | None = None,
    ) -> list[TodoItem]:
        """Filter todos by completed status and/or priority level.

        BUG: Does not implement priority filtering.
        """
        results = list(self._todos.values())
        if completed is not None:
            results = [t for t in results if t.completed == completed]
        if priority is not None:
            raise NotImplementedError("priority filtering is not implemented")
        return results

    def delete_todo(self, todo_id: str) -> bool:
        """Delete a todo by ID. Return True if deleted, False if not found.

        TODO: Not implemented yet.
        """
        raise NotImplementedError("delete_todo is not implemented")

    def export_json(self) -> str:
        """Export all todos as JSON string.

        BUG: Strips out created_at from exported dictionaries.
        """
        items: list[dict[str, Any]] = []
        for t in self._todos.values():
            d = {
                "id": t.id,
                "title": t.title,
                "priority": t.priority,
                "completed": t.completed,
                # BUG: created_at omitted
            }
            items.append(d)
        return json.dumps(items)
