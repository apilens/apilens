"""Backfill the Postgres `consumers` dimension table from ClickHouse.

The ingest service upserts consumers going forward; this seeds the table from
historical api_requests so existing projects start with a full roster:

    python manage.py backfill_consumers            # all projects
    python manage.py backfill_consumers --project-slug my-project
"""

from django.core.management.base import BaseCommand

from apps.projects.models import Consumer, Project
from core.database.clickhouse.client import get_clickhouse_client


class Command(BaseCommand):
    help = "Seed the consumers dimension table from historical ClickHouse api_requests."

    def add_arguments(self, parser):
        parser.add_argument("--project-slug", default="", help="Limit to one project slug")

    def handle(self, *args, **options):
        projects = Project.objects.filter(is_active=True)
        slug = (options.get("project_slug") or "").strip()
        if slug:
            projects = projects.filter(slug=slug)

        client = get_clickhouse_client()
        total = 0
        for project in projects:
            rows = client.execute(
                """
                SELECT
                    consumer_id,
                    argMax(consumer_name, timestamp) AS name,
                    argMax(consumer_group, timestamp) AS grp,
                    min(timestamp) AS first_seen,
                    max(timestamp) AS last_seen
                FROM api_requests
                WHERE project_id = %(project_id)s AND consumer_id != ''
                GROUP BY consumer_id
                """,
                {"project_id": str(project.id)},
            )
            count = 0
            for row in rows:
                _, created = Consumer.objects.update_or_create(
                    project=project,
                    consumer_id=str(row["consumer_id"])[:256],
                    defaults={
                        "name": str(row.get("name") or "")[:256],
                        "group": str(row.get("grp") or "")[:256],
                        "first_seen_at": row["first_seen"],
                        "last_seen_at": row["last_seen"],
                    },
                )
                count += 1
            total += count
            self.stdout.write(f"{project.slug}: {count} consumers")
        self.stdout.write(self.style.SUCCESS(f"Backfilled {total} consumers"))
