"""
ClickHouse client singleton for ItsFriday.
"""

import logging
from typing import Any

from clickhouse_driver import Client
from django.conf import settings

logger = logging.getLogger(__name__)


class ClickHouseClient:
    """
    Singleton ClickHouse client wrapper.

    Usage:
        client = ClickHouseClient()
        result = client.execute("SELECT * FROM metrics WHERE tenant_id = %(tenant_id)s", {"tenant_id": "abc123"})
    """

    _instance: "ClickHouseClient | None" = None
    _client: Client | None = None

    def __new__(cls) -> "ClickHouseClient":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        if self._client is None:
            config = settings.CLICKHOUSE
            self._client = Client(
                host=config["HOST"],
                port=config["PORT"],
                database=config["DATABASE"],
                user=config["USER"],
                password=config["PASSWORD"],
                settings={
                    "use_numpy": False,
                },
            )
            logger.info(
                "ClickHouse client initialized: %s:%s/%s",
                config["HOST"],
                config["PORT"],
                config["DATABASE"],
            )

    @property
    def client(self) -> Client:
        """Get the underlying ClickHouse client."""
        if self._client is None:
            raise RuntimeError("ClickHouse client not initialized")
        return self._client

    def execute(
        self,
        query: str,
        params: dict[str, Any] | None = None,
        with_column_types: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Execute a query and return results as a list of dictionaries.

        Args:
            query: SQL query string with optional %(param)s placeholders
            params: Dictionary of query parameters
            with_column_types: If True, include column type information

        Returns:
            List of dictionaries with column names as keys
        """
        try:
            result = self.client.execute(
                query,
                params or {},
                with_column_types=True,
            )

            rows, columns = result
            column_names = [col[0] for col in columns]

            return [dict(zip(column_names, row)) for row in rows]
        except Exception as e:
            logger.error("ClickHouse query failed: %s - %s", query[:100], str(e))
            raise

    def execute_raw(
        self,
        query: str,
        params: dict[str, Any] | None = None,
    ) -> tuple[list[tuple], list[tuple[str, str]]]:
        """
        Execute a query and return raw results with column types.

        Args:
            query: SQL query string
            params: Dictionary of query parameters

        Returns:
            Tuple of (rows, column_types)
        """
        return self.client.execute(
            query,
            params or {},
            with_column_types=True,
        )

    def insert(
        self,
        table: str,
        data: list[dict[str, Any]],
        columns: list[str] | None = None,
    ) -> int:
        """
        Bulk insert data into a table.

        Args:
            table: Table name
            data: List of dictionaries with data to insert
            columns: Optional list of column names (inferred from first row if not provided)

        Returns:
            Number of rows inserted
        """
        if not data:
            return 0

        if columns is None:
            columns = list(data[0].keys())

        # Convert list of dicts to list of tuples
        rows = [tuple(row.get(col) for col in columns) for row in data]

        try:
            result = self.client.execute(
                f"INSERT INTO {table} ({', '.join(columns)}) VALUES",
                rows,
            )
            logger.debug("Inserted %d rows into %s", len(rows), table)
            return result
        except Exception as e:
            logger.error("ClickHouse insert failed: %s - %s", table, str(e))
            raise

    def ping(self) -> bool:
        """Check if ClickHouse is reachable."""
        try:
            self.client.execute("SELECT 1")
            return True
        except Exception:
            return False


# Convenience function to get client instance
def get_clickhouse_client() -> ClickHouseClient:
    """Get the ClickHouse client singleton instance."""
    return ClickHouseClient()
