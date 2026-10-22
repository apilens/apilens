from fastapi.testclient import TestClient

from apilens_ai.main import create_app


def test_livez() -> None:
    client = TestClient(create_app())
    resp = client.get("/livez")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_readyz() -> None:
    client = TestClient(create_app())
    resp = client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_docs_are_not_exposed() -> None:
    client = TestClient(create_app())
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
