import hmac
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from app.indexing import index_repository


class HealthResponse(BaseModel):
    status: str
    service: str
    timestamp: str


class IndexRequest(BaseModel):
    repoId: str
    cloneUrl: str
    token: str | None = None


class IndexResponse(BaseModel):
    status: str
    repoId: str
    commitSha: str = ""
    stats: dict[str, Any] = {}


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


@app.post(
    "/internal/index",
    response_model=IndexResponse,
    dependencies=[Depends(verify_internal_key)],
)
async def index_repo(payload: IndexRequest) -> IndexResponse:
    if not ObjectId.is_valid(payload.repoId):
        raise HTTPException(status_code=400, detail="Invalid repoId")

    try:
        result = await index_repository(
            repo_id=payload.repoId,
            clone_url=payload.cloneUrl,
            token=payload.token,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return IndexResponse(
        status=str(result["status"]),
        repoId=payload.repoId,
        commitSha=str(result.get("commitSha", "")),
        stats=dict(result.get("stats", {})),
    )
