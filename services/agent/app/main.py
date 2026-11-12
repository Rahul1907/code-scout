import hmac
from datetime import UTC, datetime

from bson import ObjectId
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from app.db.mongo import get_db


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
    db = get_db()
    try:
        oid = ObjectId(payload.repoId)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid repoId") from exc

    db["repos"].update_one(
        {"_id": oid},
        {
            "$set": {
                "status": "cloning",
                "progress": {"stage": "cloning", "processedFiles": 0, "totalFiles": 0},
                "error": "",
            }
        },
    )
    return IndexResponse(status="cloning", repoId=payload.repoId)
