import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from django.core.management.base import BaseCommand, CommandError

from apps.projects.models import App
from apps.projects.services import IngestService


@dataclass
class RequestRow:
    timestamp: datetime
    environment: str
    method: str
    path: str
    status_code: int
    response_time_ms: float
    request_size: int
    response_size: int
    ip_address: str
    user_agent: str


ENDPOINTS = [
    ("GET", "/v1/users"),
    ("POST", "/v1/users"),
    ("GET", "/v1/users/{id}"),
    ("PATCH", "/v1/users/{id}"),
    ("DELETE", "/v1/users/{id}"),
    ("GET", "/v1/sessions"),
    ("POST", "/v1/auth/login"),
    ("POST", "/v1/auth/logout"),
    ("POST", "/v1/auth/refresh"),
    ("GET", "/v1/orders"),
    ("POST", "/v1/orders"),
    ("GET", "/v1/orders/{id}"),
    ("PATCH", "/v1/orders/{id}"),
    ("GET", "/v1/orders/{id}/items"),
    ("POST", "/v1/orders/{id}/cancel"),
    ("GET", "/v1/products"),
    ("GET", "/v1/products/{id}"),
    ("POST", "/v1/products"),
    ("PATCH", "/v1/products/{id}"),
    ("GET", "/v1/payments"),
    ("POST", "/v1/payments"),
    ("GET", "/v1/invoices"),
    ("POST", "/v1/invoices"),
    ("GET", "/v1/webhooks"),
    ("POST", "/v1/webhooks"),
    ("GET", "/v1/analytics/events"),
    ("POST", "/v1/analytics/events"),
    ("GET", "/v1/health"),
]

USER_AGENTS = [
    "api-lens-web/1.0",
    "api-lens-worker/1.7",
    "billing-service/2.3",
    "checkout-service/4.1",
    "internal-dashboard/0.9",
    "mobile-ios/7.2",
    "mobile-android/6.8",
    "partner-integration-a/3.4",
    "partner-integration-b/2.0",
    "postman-runtime/7.39",
]

IP_BLOCKS = ["10.0.1.", "10.0.2.", "10.1.7.", "172.18.3.", "192.168.10."]
ENVIRONMENTS = ["production", "staging", "development"]


def _status_for_method(method: str) -> int:
    r = random.random()
    if method == "GET":
        if r < 0.90:
            return 200
        if r < 0.96:
            return 404
        if r < 0.985:
            return 429
        return 500
    if method in {"POST", "PATCH", "PUT"}:
        if r < 0.80:
            return 200
        if r < 0.90:
            return 201
        if r < 0.95:
            return 400
        if r < 0.985:
            return 422
        return 503
    if method == "DELETE":
        if r < 0.85:
            return 204
        if r < 0.93:
            return 404
        if r < 0.985:
            return 409
        return 500
    return 200


def _latency_for_path(path: str, status_code: int) -> float:
    if "/analytics" in path:
        base = random.uniform(180, 420)
    elif "/payments" in path or "/invoices" in path:
        base = random.uniform(130, 320)
    elif "/auth" in path:
        base = random.uniform(70, 180)
    else:
        base = random.uniform(35, 140)
    if status_code >= 500:
        base *= random.uniform(1.6, 2.4)
    elif status_code >= 400:
        base *= random.uniform(1.1, 1.6)
    return round(base, 2)


def _materialize_path(template: str) -> str:
    return (
        template.replace("{id}", str(random.randint(1, 4000)))
        .replace("{order_id}", str(random.randint(10000, 99999)))
    )


class Command(BaseCommand):
    help = "Seed synthetic API request traffic into ClickHouse for analytics views."

    def add_arguments(self, parser):
        parser.add_argument("--app-slug", required=True, help="Target app slug (e.g. sentinel)")
        parser.add_argument("--count", type=int, default=6000, help="Number of request rows to generate")
        parser.add_argument("--days", type=int, default=14, help="Time window in past days")
        parser.add_argument(
            "--batch-size", type=int, default=1000, help="Batch size per IngestService call (max 1000 recommended)"
        )
        parser.add_argument("--seed", type=int, default=42, help="Random seed for deterministic output")

    def handle(self, *args, **options):
        app_slug = options["app_slug"]
        count = max(1, int(options["count"]))
        days = max(1, int(options["days"]))
        batch_size = max(1, min(int(options["batch_size"]), 1000))
        random.seed(int(options["seed"]))

        try:
            app = App.objects.get(slug=app_slug, is_active=True)
        except App.DoesNotExist as exc:
            raise CommandError(f"App '{app_slug}' not found") from exc

        now = datetime.now(timezone.utc)
        start = now - timedelta(days=days)
        rows: list[RequestRow] = []

        for _ in range(count):
            method, template = random.choice(ENDPOINTS)
            path = _materialize_path(template)
            status_code = _status_for_method(method)
            timestamp = start + timedelta(seconds=random.randint(0, int((now - start).total_seconds())))
            rows.append(
                RequestRow(
                    timestamp=timestamp,
                    environment=random.choices(ENVIRONMENTS, weights=[0.68, 0.22, 0.10], k=1)[0],
                    method=method,
                    path=path,
                    status_code=status_code,
                    response_time_ms=_latency_for_path(path, status_code),
                    request_size=random.randint(120, 2800),
                    response_size=random.randint(300, 15000),
                    ip_address=f"{random.choice(IP_BLOCKS)}{random.randint(2, 250)}",
                    user_agent=random.choice(USER_AGENTS),
                )
            )

        accepted_total = 0
        for i in range(0, len(rows), batch_size):
            accepted_total += IngestService.ingest(str(app.id), rows[i : i + batch_size])

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded {accepted_total} request rows for app '{app_slug}' across {days} days."
            )
        )
