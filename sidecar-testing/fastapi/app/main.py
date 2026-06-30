import os
from pathlib import Path
from fastapi import Depends, FastAPI, Request
from apilens.fastapi import ApiLensMiddleware, set_consumer
from dotenv import load_dotenv
import uvicorn
import random
from typing import List

from fastapi import Depends, FastAPI, Request
from pydantic import BaseModel

import random
from fastapi import Request

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


USERS = [
    {"name": "Neel Bhatt", "email": "neel.bhatt@example.com"},
    {"name": "Aarav Patel", "email": "aarav.patel@example.com"},
    {"name": "Riya Shah", "email": "riya.shah@example.com"},
    {"name": "Vivaan Mehta", "email": "vivaan.mehta@example.com"},
    {"name": "Ananya Desai", "email": "ananya.desai@example.com"},
    {"name": "Krish Patel", "email": "krish.patel@example.com"},
    {"name": "Diya Joshi", "email": "diya.joshi@example.com"},
    {"name": "Arjun Shah", "email": "arjun.shah@example.com"},
    {"name": "Meera Trivedi", "email": "meera.trivedi@example.com"},
    {"name": "Kabir Pandya", "email": "kabir.pandya@example.com"},
]

async def consumer_dep(request: Request):
    # If the client sends these headers, use them.
    user_email = request.headers.get("X-User-Email")
    user_role = request.headers.get("X-User-Role")
    user_name = request.headers.get("X-User-Name")

    if user_email:
        set_consumer(
            request,
            identifier=user_email,
            name=user_name,
            group=user_role or None,
        )
    else:
        # Otherwise pick a random user.
        user = random.choice(USERS)

        set_consumer(
            request,
            identifier=user["email"],
            name=user["name"],
            group=user_role or None,
        )

# -----------------------------
# Mock Request Models
# -----------------------------
class OrderItem(BaseModel):
    product_id: str
    product_name: str
    quantity: int
    price: float


class Customer(BaseModel):
    customer_id: str
    name: str
    email: str


class OrderRequest(BaseModel):
    order_id: str
    customer: Customer
    items: List[OrderItem]
    payment_method: str
    shipping_address: str
    priority: str


@app.post("/v1/orders")
async def create_order(
    order: OrderRequest,
    _: None = Depends(consumer_dep),
):
    return {
        "message": "Order created successfully",
        "order": order,
    }

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
