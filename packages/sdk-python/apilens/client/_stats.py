"""Client health snapshot (``ApiLensClient.stats()``)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

# Mirrors ``client.DROP_TRUNCATED``: those records were sent, not dropped.
_TRUNCATED = "truncated"


@dataclass(frozen=True, slots=True)
class ClientStats:
    """Point-in-time view of the SDK's delivery pipeline.

    Counters are cumulative since the client was created. ``drop_counts`` is
    keyed by drop reason (see ``ApiLensClient.drop_counts()``); ``truncated``
    records were still sent and are not part of ``dropped``.
    """

    queued_records: int = 0
    queued_bytes: int = 0
    sent_batches: int = 0
    sent_records: int = 0
    failed_batches: int = 0
    drop_counts: dict[str, int] = field(default_factory=dict)
    last_error: str = ""
    last_success_at: datetime | None = None

    @property
    def dropped(self) -> int:
        """Records dropped for any reason (excludes ``truncated``)."""
        return sum(n for reason, n in self.drop_counts.items() if reason != _TRUNCATED)

    def to_dict(self) -> dict[str, object]:
        """JSON-ready form, e.g. for the heartbeat payload or a metrics exporter."""
        return {
            "queued_records": self.queued_records,
            "queued_bytes": self.queued_bytes,
            "sent_batches": self.sent_batches,
            "sent_records": self.sent_records,
            "failed_batches": self.failed_batches,
            "dropped": self.dropped,
            "drop_counts": dict(self.drop_counts),
            "last_error": self.last_error,
            "last_success_at": self.last_success_at.isoformat() if self.last_success_at else None,
        }

    def summary(self) -> str:
        """One-line, log-friendly rendering."""
        drops = ",".join(f"{k}={v}" for k, v in self.drop_counts.items() if v) or "none"
        last_ok = self.last_success_at.isoformat() if self.last_success_at else "never"
        line = (
            f"queued={self.queued_records} ({self.queued_bytes}B) "
            f"sent={self.sent_records} records/{self.sent_batches} batches "
            f"failed_batches={self.failed_batches} dropped={self.dropped} [{drops}] "
            f"last_success={last_ok}"
        )
        if self.last_error:
            line += f" last_error={self.last_error!r}"
        return line
