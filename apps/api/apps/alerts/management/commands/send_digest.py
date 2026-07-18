"""Send due API-health digests (Phase 6 Narrator).

Run on a schedule (hourly or daily cron / a small loop):

    python manage.py send_digest            # send all due subscriptions
    python manage.py send_digest --all       # ignore cadence, send every active sub now

Each subscription tracks last_sent_at so a period's digest goes out once.
"""

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Send due API-health digests through their configured channels."

    def add_arguments(self, parser):
        parser.add_argument("--all", action="store_true", help="Send every active subscription now, ignoring cadence")

    def handle(self, *args, **options):
        from apps.alerts.digest import build_and_send, send_due
        from apps.alerts.models import DigestSubscription

        if options["all"]:
            results = []
            for sub in DigestSubscription.objects.filter(is_active=True).select_related("project"):
                if sub.channels.exists():
                    results.append(build_and_send(sub, force=True))
        else:
            results = send_due()

        for r in results:
            ok = sum(1 for d in r["delivery"].values() if d.get("ok"))
            self.stdout.write(f"[digest] {r['project']}: {ok}/{len(r['delivery'])} channels ok")
        self.stdout.write(self.style.SUCCESS(f"Sent {len(results)} digest(s)"))
