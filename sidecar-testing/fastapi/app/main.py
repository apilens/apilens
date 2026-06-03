import os
from pathlib import Path
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware
from dotenv import load_dotenv
import uvicorn

# Load .env file from parent directory
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

app = FastAPI()

app.add_middleware(
    ApiLensMiddleware,
    api_key=os.getenv("APILENS_API_KEY"),
    project_slug=os.getenv("APILENS_PROJECT_SLUG"),
    app_id=os.getenv("APILENS_APP_ID"),
    base_url=os.getenv("APILENS_BASE_URL", "http://localhost:8000/ingest/v1"),
    env=os.getenv("APILENS_ENVIRONMENT", "production"),
    enable_request_logging=True,
    log_request_body=True,
    log_response_body=True,
)

@app.get("/v1/orders")
def list_orders():

    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=4321,
        reload=True
    )
