from pydantic import BaseModel


class RetrievedChunk(BaseModel):
    chunk_id: str
    repo_id: str
    file_path: str
    language: str
    symbol_name: str
    symbol_type: str
    start_line: int
    end_line: int
    content: str
    score: float = 0.0
