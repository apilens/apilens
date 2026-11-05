"""Request-detail sampling (``sample_rate`` and ``sample_on_request``).

Sampling never changes metrics: every request still sends its base record
(method, path, status, latency, sizes, consumer, trace id), because traffic
counts and error rates are derived from those records. A request that is
sampled *out* only loses its detail — headers, bodies, spans and the auto
error-trace log — and carries ``sampled=False`` on the wire.

Trace context is still resolved and propagated downstream for sampled-out
requests, so child services decide independently.

``sample_on_request`` (see :class:`RequestSampler`) overrides the rate per
request at request start, before any body is buffered.
"""

from __future__ import annotations

import logging
import math
import random
from collections.abc import Callable
from typing import Any, Union

logger = logging.getLogger("apilens")

_rng = random.Random()

# ``(RequestInfo) -> bool | float | None``: True/False keep/drop the detail
# outright, a number is a keep probability, None defers to ``sample_rate``.
SampleOnRequest = Callable[[Any], Union[bool, float, None]]


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

    def decide(self, info: Callable[[], Any]) -> bool:
        """Sample one request (``info`` is unused without a callback)."""
        return self.sample()


class RequestSampler(DetailSampler):
    """:class:`DetailSampler` plus the optional ``sample_on_request`` callback.

    The callback runs at request start, before any body is buffered, with a
    :class:`~apilens.RequestInfo` (method, path, query, user agent, headers,
    client IP). Its answer decides the request:

    * ``True`` / ``False`` — final: keep / drop the detail.
    * a number — probability of keeping (clamped to 0.0-1.0).
    * ``None`` — fall back to ``sample_rate``.

    An exception (or an unusable return value) never reaches the handler: it
    is logged once per sampler and treated as ``None``.
    """

    __slots__ = ("callback", "_warned")

    def __init__(
        self,
        rate: float = 1.0,
        callback: SampleOnRequest | None = None,
        *,
        rng: random.Random | None = None,
    ) -> None:
        super().__init__(rate, rng=rng)
        if callback is not None and not callable(callback):
            raise TypeError(f"sample_on_request must be callable, got {type(callback).__name__}")
        self.callback = callback
        self._warned = False

    def decide(self, info: Callable[[], Any]) -> bool:
        """Sample one request. ``info`` builds its RequestInfo; it is only
        called when a callback is configured, so the default path stays free."""
        callback = self.callback
        if callback is None:
            return self.sample()
        try:
            verdict = callback(info())
        except Exception:
            self._warn("apilens: sample_on_request raised; falling back to sample_rate", exc_info=True)
            return self.sample()
        if verdict is None:
            return self.sample()
        if isinstance(verdict, bool):
            return verdict
        if isinstance(verdict, (int, float)) and not math.isnan(verdict):
            if verdict >= 1:
                return True
            if verdict <= 0:
                return False
            return self._random() < verdict
        self._warn(
            "apilens: sample_on_request returned %r (expected bool, float or None); "
            "falling back to sample_rate",
            verdict,
        )
        return self.sample()

    def _warn(self, message: str, *args: Any, exc_info: bool = False) -> None:
        if self._warned:
            return
        self._warned = True
        logger.warning(message, *args, exc_info=exc_info)
