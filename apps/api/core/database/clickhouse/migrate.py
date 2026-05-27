"""
ClickHouse migration runner for apilens.
"""

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

from .client import get_clickhouse_client

logger = logging.getLogger(__name__)


class MigrationInfo(NamedTuple):
    """Information about a migration file."""

    version: str
    name: str
    path: Path


class ClickHouseMigrator:
    """
    Simple migration runner for ClickHouse.

    Migration files should be named: 001_description.sql, 002_another.sql, etc.
    """

    MIGRATIONS_DIR = Path(__file__).parent / "migrations"
    MIGRATION_TABLE = "_schema_migrations"

    def __init__(self) -> None:
        self.client = get_clickhouse_client()

    def _ensure_migration_table(self) -> None:
        """Create the migration tracking table if it doesn't exist."""
        self.client.client.execute(f"""
            CREATE TABLE IF NOT EXISTS {self.MIGRATION_TABLE} (
                version String,
                name String,
                applied_at DateTime DEFAULT now()
            ) ENGINE = MergeTree()
            ORDER BY version
        """)
        logger.debug("Migration table ensured: %s", self.MIGRATION_TABLE)

    def _get_applied_migrations(self) -> set[str]:
        """Get set of already applied migration versions."""
        self._ensure_migration_table()
        result = self.client.execute(
            f"SELECT version FROM {self.MIGRATION_TABLE}"
        )
        return {row["version"] for row in result}

    def _get_pending_migrations(self) -> list[MigrationInfo]:
        """Get list of pending migrations sorted by version."""
        applied = self._get_applied_migrations()
        pending = []

        # Find all .sql files in migrations directory
        if not self.MIGRATIONS_DIR.exists():
            logger.warning("Migrations directory not found: %s", self.MIGRATIONS_DIR)
            return []

        for sql_file in sorted(self.MIGRATIONS_DIR.glob("*.sql")):
            # Parse filename: 001_description.sql
            match = re.match(r"^(\d+)_(.+)\.sql$", sql_file.name)
            if match:
                version = match.group(1)
                name = match.group(2)
                if version not in applied:
                    pending.append(MigrationInfo(version=version, name=name, path=sql_file))

        return pending

    def _run_migration(self, migration: MigrationInfo) -> None:
        """Execute a single migration file."""
        logger.info("Running migration: %s_%s", migration.version, migration.name)

        # Read and execute migration SQL
        sql_content = migration.path.read_text()

        # Split by semicolons and execute each statement
        statements = [s.strip() for s in sql_content.split(";") if s.strip()]

        for statement in statements:
            if statement:
                try:
                    self.client.client.execute(statement)
                except Exception as e:
                    logger.error(
                        "Migration %s failed at statement: %s... - %s",
                        migration.version,
                        statement[:50],
                        str(e),
                    )
                    raise

        # Record migration as applied
        self.client.client.execute(
            f"INSERT INTO {self.MIGRATION_TABLE} (version, name) VALUES",
            [(migration.version, migration.name)],
        )

        logger.info("Migration %s_%s applied successfully", migration.version, migration.name)

    def migrate(self, dry_run: bool = False) -> list[MigrationInfo]:
        """
        Run all pending migrations.

        Args:
            dry_run: If True, only show what would be run without executing

        Returns:
            List of migrations that were (or would be) applied
        """
        self._ensure_migration_table()
        pending = self._get_pending_migrations()

        if not pending:
            logger.info("No pending migrations")
            return []

        logger.info("Found %d pending migration(s)", len(pending))

        if dry_run:
            for migration in pending:
                logger.info("[DRY RUN] Would apply: %s_%s", migration.version, migration.name)
            return pending

        for migration in pending:
            self._run_migration(migration)

        return pending

    def status(self) -> dict[str, list[MigrationInfo]]:
        """
        Get migration status.

        Returns:
            Dictionary with 'applied' and 'pending' migration lists
        """
        self._ensure_migration_table()

        # Get applied migrations
        applied_result = self.client.execute(
            f"SELECT version, name, applied_at FROM {self.MIGRATION_TABLE} ORDER BY version"
        )
        applied = [
            MigrationInfo(
                version=row["version"],
                name=row["name"],
                path=self.MIGRATIONS_DIR / f"{row['version']}_{row['name']}.sql",
            )
            for row in applied_result
        ]

        # Get pending migrations
        pending = self._get_pending_migrations()

        return {
            "applied": applied,
            "pending": pending,
        }
