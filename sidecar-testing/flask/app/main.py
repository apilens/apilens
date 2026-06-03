import os

from dotenv import load_dotenv
from flask import Flask, jsonify

from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_app

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


@app.get("/health")
def health():
    return jsonify({"status": "ok", "framework": "flask"})


@app.get("/v1/invoices/<invoice_id>")
def get_invoice(invoice_id: str):
    return jsonify({"invoice_id": invoice_id, "status": "fetched"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8012")), debug=True)
