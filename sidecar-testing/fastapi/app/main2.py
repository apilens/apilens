from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware
import uvicorn
import os

app = FastAPI()

app.add_middleware(
    ApiLensMiddleware,
    api_key=os.getenv("APILENS_API_KEY", "apilens_8q8W4ivYhr78ZhgYke8_s_fhfgUH0x1xR_G_pt4hUkGosziMbeGifQ"),
    project_slug=os.getenv("APILENS_PROJECT_SLUG", "astra"),
    app_id=os.getenv("APILENS_APP_ID", "sidecar"),
    base_url=os.getenv("APILENS_BASE_URL", "http://localhost:8000/api/v1"),
    env=os.getenv("APILENS_ENVIRONMENT", "production"),
    enable_request_logging=True,
    log_request_body=True,
    log_response_body=True,
)

@app.get("/v1/orders")
def list_orders():
    return {"ok": False}


if __name__ == "__main__":
    uvicorn.run(
        "main2:app",
        host="0.0.0.0",
        port=1111,
        reload=True
    )


