from fastapi.testclient import TestClient

from app.main import app


def test_internal_health() -> None:
    client = TestClient(app)
    response = client.get("/internal/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "agent"
    assert isinstance(data["timestamp"], str)

