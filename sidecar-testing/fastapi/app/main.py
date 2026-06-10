import os
from pathlib import Path
from fastapi import Depends, FastAPI, Request
from apilens.fastapi import ApiLensMiddleware, set_consumer
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
    base_url="http://localhost:8001/v1",
    project_slug="observeops",
    api_key="apilens_UheLV-Pql8vnYUh2P5v10T0mZBnwdgooKu9Ppx4dlyL600NdOz45-g",
    app_id="order-service",
)


# --- Consumer identification ---
# Inject as a FastAPI Dependency so it runs on every route that uses it.
# Test with: curl -H "X-User-Email: alice@example.com" http://localhost:4321/v1/orders
async def consumer_dep(request: Request):
    user_email = request.headers.get("X-User-Email")
    user_name = request.headers.get("X-User-Name")
    user_role = request.headers.get("X-User-Role")
    if user_email:
        set_consumer(
            request,                   # pass the Request object for ASGI state
            identifier=user_email,     # required: stable id
            name=user_name or None,    # optional: display name
            group=user_role or None,   # optional: team / role / tier
        )


@app.get("/v1/orders")
async def list_orders(_: None = Depends(consumer_dep)):
    return {"ok": True}



if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=4321,
        reload=True
    )
