import os

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request

from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_app, set_consumer

load_dotenv()

app = Flask(__name__)

# The API key is project-level, so you only need the key + which app it's for.
client = ApiLensClient(
    ApiLensConfig(
        api_key=os.getenv("APILENS_API_KEY", ""),
        base_url=os.getenv("APILENS_BASE_URL", "https://ingest.apilens.ai/v1"),
    )
)

instrument_app(app, client, app_id=os.getenv("APILENS_APP_ID", ""))


# --- Consumer identification ---
# Call set_consumer() in before_request — no `request` arg needed.
# The identity is stored on a contextvar and picked up by the middleware.
@app.before_request
def identify_consumer():
    # In a real app: check session/JWT and set g.current_user.
    # Here we read a demo header so you can test with curl:
    #   curl -H "X-User-Email: alice@example.com" http://localhost:8012/v1/invoices/42
    user_email = request.headers.get("X-User-Email")
    user_name = request.headers.get("X-User-Name")
    user_role = request.headers.get("X-User-Role")
    if user_email:
        set_consumer(
            identifier=user_email,          # required: stable id
            name=user_name or None,         # optional: display name
            group=user_role or None,        # optional: team / role / tier
        )


@app.get("/health")
def health():
    return jsonify({"status": "ok", "framework": "flask"})


@app.get("/v1/invoices/<invoice_id>")
def get_invoice(invoice_id: str):
    return jsonify({"invoice_id": invoice_id, "status": "fetched"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8012")), debug=True)
