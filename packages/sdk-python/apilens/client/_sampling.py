"""Request-detail sampling (``sample_rate``).

Sampling never changes metrics: every request still sends its base record
(method, path, status, latency, sizes, consumer, trace id), because traffic
counts and error rates are derived from those records. A request that is
sampled *out* only loses its detail — headers, bodies, spans and the auto
error-trace log — and carries ``sampled=False`` on the wire.

Trace context is still resolved and propagated downstream for sampled-out
requests, so child services decide independently.
"""

from __future__ import annotations

import math
import random

_rng = random.Random()


def validate_sample_rate(rate: float) -> float:
    """Return ``rate`` as a float, raising ``ValueError`` unless 0.0 <= rate <= 1.0."""
    if isinstance(rate, bool):
        raise ValueError(f"sample_rate must be a number between 0.0 and 1.0, got {rate!r}")
    try:
        value = float(rate)
    except (TypeError, ValueError):
        raise ValueError(f"sample_rate must be a number between 0.0 and 1.0, got {rate!r}") from None
    if math.isnan(value) or value < 0.0 or value > 1.0:
        raise ValueError(f"sample_rate must be between 0.0 and 1.0, got {rate!r}")
    return value


class DetailSampler:
    """Per-request decision: keep this request's detail or not.

    ``1.0`` and ``0.0`` are exact and never touch the PRNG; anything in
    between draws once from a ``random.Random`` (Mersenne Twister — fast, and
    the decision is not security-sensitive).
    """

    __slots__ = ("rate", "_random")

    def __init__(self, rate: float = 1.0, *, rng: random.Random | None = None) -> None:
        self.rate = validate_sample_rate(rate)
        self._random = (rng or _rng).random

    def sample(self) -> bool:
        rate = self.rate
        if rate >= 1.0:
            return True
        if rate <= 0.0:
            return False
        return self._random() < rate
