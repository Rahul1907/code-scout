from pydantic import BaseModel, Field


class CommandResult(BaseModel):
    exit_code: int = Field(default=0)
    stdout: str = Field(default="")
    stderr: str = Field(default="")
    duration_ms: int = Field(default=0)
    timed_out: bool = Field(default=False)

