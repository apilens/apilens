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

# The API key is project-level, so you only need the key + which app it's for.
# (base_url just points this example at a local backend; it defaults to
# https://ingest.apilens.ai/v1 in production.)
app.add_middleware(
    ApiLensMiddleware,
    api_key=os.getenv("APILENS_API_KEY"),
    app_id=os.getenv("APILENS_APP_ID"),
    base_url=os.getenv("APILENS_BASE_URL", "http://localhost:8000/ingest/v1"),
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
