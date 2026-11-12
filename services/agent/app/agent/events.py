import json
import re
from typing import Any

from pydantic import BaseModel

CITATION_RE = re.compile(r"\[([A-Za-z0-9_.\-/\\]+):(\d+)(?:-(\d+))?\]")


class Citation(BaseModel):
    filePath: str
    startLine: int
    endLine: int


def format_sse(event_type: str, data: dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


def extract_citations(text: str) -> list[Citation]:
    seen: set[tuple[str, int, int]] = set()
    citations: list[Citation] = []
    for match in CITATION_RE.finditer(text):
        file_path = match.group(1).replace("\\", "/")
        start_line = int(match.group(2))
        end_line = int(match.group(3)) if match.group(3) else start_line
        if end_line < start_line:
            end_line = start_line
        key = (file_path, start_line, end_line)
        if key not in seen:
            seen.add(key)
            citations.append(Citation(filePath=file_path, startLine=start_line, endLine=end_line))
    return citations

