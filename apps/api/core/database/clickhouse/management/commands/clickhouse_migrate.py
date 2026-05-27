"""
Django management command for ClickHouse migrations.
"""

from django.core.management.base import BaseCommand

from core.database.clickhouse.migrate import ClickHouseMigrator


class Command(BaseCommand):
    help = "Run ClickHouse database migrations"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show pending migrations without applying them",
        )
        parser.add_argument(
            "--status",
            action="store_true",
            help="Show migration status (applied and pending)",
        )

    def handle(self, *args, **options):
        migrator = ClickHouseMigrator()

        if options["status"]:
            self._show_status(migrator)
        else:
            self._run_migrations(migrator, dry_run=options["dry_run"])

    def _show_status(self, migrator: ClickHouseMigrator) -> None:
        """Display migration status."""
        status = migrator.status()

        self.stdout.write(self.style.MIGRATE_HEADING("Applied migrations:"))
        if status["applied"]:
            for migration in status["applied"]:
                self.stdout.write(
                    self.style.SUCCESS(f"  [X] {migration.version}_{migration.name}")
                )
        else:
            self.stdout.write("  (none)")

        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING("Pending migrations:"))
        if status["pending"]:
            for migration in status["pending"]:
                self.stdout.write(
                    self.style.WARNING(f"  [ ] {migration.version}_{migration.name}")
                )
        else:
            self.stdout.write("  (none)")

    def _run_migrations(self, migrator: ClickHouseMigrator, dry_run: bool) -> None:
        """Run pending migrations."""
        if dry_run:
            self.stdout.write(self.style.MIGRATE_HEADING("Dry run mode - no changes will be made"))

        try:
            applied = migrator.migrate(dry_run=dry_run)

            if not applied:
                self.stdout.write(self.style.SUCCESS("No pending ClickHouse migrations."))
            else:
                action = "Would apply" if dry_run else "Applied"
                self.stdout.write(
                    self.style.SUCCESS(f"{action} {len(applied)} migration(s):")
                )
                for migration in applied:
                    self.stdout.write(f"  - {migration.version}_{migration.name}")

        except Exception as e:
            self.stderr.write(self.style.ERROR(f"Migration failed: {e}"))
            raise
