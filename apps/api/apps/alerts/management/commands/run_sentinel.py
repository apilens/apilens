"""The Sentinel evaluator loop.

Run as its own process/container (like the ingest split):

    python manage.py run_sentinel                # loop, 60s ticks
    python manage.py run_sentinel --once         # single tick (cron-friendly)
    python manage.py run_sentinel --interval 30

Each tick drains the ingest-written AlertSignal outbox (new-issue/regression
rules) and evaluates due metric monitors. State survives restarts (Postgres
alert_states), so the loop is safely restartable; run exactly one instance.
"""

import time

from django.core.management.base import BaseCommand

from apps.alerts.engine import run_tick


class Command(BaseCommand):
    help = "Run the Sentinel alert evaluator (signals + metric monitors)."

    def add_arguments(self, parser):
        parser.add_argument("--interval", type=int, default=60, help="Seconds between ticks")
        parser.add_argument("--once", action="store_true", help="Run one tick and exit")

    def handle(self, *args, **options):
        interval = max(10, int(options["interval"]))
        while True:
            started = time.monotonic()
            try:
                stats = run_tick()
                self.stdout.write(
                    f"[sentinel] signals={stats['signals']} "
                    f"rules={stats['rules_evaluated']} notifications={stats['notifications']}"
                )
            except Exception as exc:  # noqa: BLE001 — the loop must survive
                self.stderr.write(f"[sentinel] tick failed: {exc}")
            if options["once"]:
                break
            elapsed = time.monotonic() - started
            time.sleep(max(1.0, interval - elapsed))
