"""HTTP entrypoint for the AI/ML service.

Run locally with ``uv run uvicorn apilens_ai.main:app --reload``.
"""

from fastapi import FastAPI

from apilens_ai import __version__
from apilens_ai.config import get_settings


def create_app() -> FastAPI:
    """Build the FastAPI application."""
    settings = get_settings()
    app = FastAPI(
        title="APILens AI",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings

    @app.get("/livez")
    def livez() -> dict[str, str]:  # pyright: ignore[reportUnusedFunction]
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:  # pyright: ignore[reportUnusedFunction]
        return {"status": "ok"}

    return app


app = create_app()
