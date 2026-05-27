"""
Management command to backfill project_id in ClickHouse tables.

This command populates the project_id column in api_requests and api_logs tables
based on the app_id → project_id mapping from PostgreSQL.

Usage:
    python manage.py backfill_clickhouse_project_ids [--dry-run] [--batch-size 1000]
"""

from django.core.management.base import BaseCommand, CommandError

from apps.projects.models import App
from core.database.clickhouse.client import get_clickhouse_client


class Command(BaseCommand):
    help = "Backfill project_id in ClickHouse api_requests and api_logs tables"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be updated without making changes",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=1000,
            help="Number of apps to process in each batch (default: 1000)",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        batch_size = options["batch_size"]

        if dry_run:
            self.stdout.write(self.style.WARNING("DRY RUN MODE - No changes will be made"))

        # Build app_id → project_id mapping from PostgreSQL
        self.stdout.write("Building app_id → project_id mapping...")
        app_to_project = {}
        apps = App.objects.select_related("project").all()

        for app in apps:
            app_to_project[str(app.id)] = str(app.project_id)

        self.stdout.write(
            self.style.SUCCESS(f"Found {len(app_to_project)} apps to process")
        )

        if not app_to_project:
            self.stdout.write(self.style.WARNING("No apps found. Nothing to backfill."))
            return

        # Backfill api_requests table
        self.stdout.write("\nBackfilling api_requests table...")
        self._backfill_table(
            "api_requests",
            app_to_project,
            dry_run=dry_run,
            batch_size=batch_size,
        )

        # Backfill api_logs table
        self.stdout.write("\nBackfilling api_logs table...")
        self._backfill_table(
            "api_logs",
            app_to_project,
            dry_run=dry_run,
            batch_size=batch_size,
        )

        if dry_run:
            self.stdout.write(
                self.style.SUCCESS(
                    "\nDRY RUN COMPLETE - Run without --dry-run to apply changes"
                )
            )
        else:
            self.stdout.write(self.style.SUCCESS("\nBackfill completed successfully!"))

    def _backfill_table(self, table_name: str, app_to_project: dict, dry_run: bool, batch_size: int):
        """
        Backfill project_id for a specific ClickHouse table.
        """
        client = get_clickhouse_client()
        total_updated = 0

        # Process apps in batches
        app_items = list(app_to_project.items())
        for i in range(0, len(app_items), batch_size):
            batch = app_items[i : i + batch_size]

            for app_id, project_id in batch:
                # Count rows that need updating
                count_query = f"""
                    SELECT count(*) as cnt
                    FROM {table_name}
                    WHERE app_id = '{app_id}' AND project_id = ''
                """
                result = client.execute(count_query)
                count = result[0]["cnt"] if result else 0

                if count == 0:
                    continue

                self.stdout.write(
                    f"  {table_name}: app_id={app_id[:8]}... → project_id={project_id[:8]}... ({count} rows)"
                )

                if not dry_run:
                    # Update project_id for this app
                    update_query = f"""
                        ALTER TABLE {table_name}
                        UPDATE project_id = '{project_id}'
                        WHERE app_id = '{app_id}' AND project_id = ''
                    """
                    client.execute(update_query)

                total_updated += count

            # Progress indicator
            self.stdout.write(
                f"  Processed {min(i + batch_size, len(app_items))}/{len(app_items)} apps "
                f"({total_updated} rows {'would be ' if dry_run else ''}updated)"
            )

        self.stdout.write(
            self.style.SUCCESS(
                f"  Total: {total_updated} rows in {table_name} {'would be ' if dry_run else ''}updated"
            )
        )
