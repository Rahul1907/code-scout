import hmac
from datetime import UTC, datetime

from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings


class HealthResponse(BaseModel):
    status: str
    service: str
    timestamp: str


def verify_internal_key(x_internal_key: str | None = Header(default=None)) -> None:
    settings = get_settings()
    if not x_internal_key or not hmac.compare_digest(x_internal_key, settings.internal_api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Key header",
        )


app = FastAPI(title="CodeScout Agent Service", version="0.1.0")


@app.get("/internal/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="agent",
        timestamp=datetime.now(UTC).isoformat(),
    )

