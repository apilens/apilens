"""Lightweight, offline IP → country resolution.

Backed by ``geoip2fast`` (a bundled, free country-level database — no MaxMind
account, no network calls). Resolution happens server-side at query time so the
SDK and ingest pipeline stay untouched. Everything degrades gracefully: a
missing library, a private/loopback IP, or an unrecognised address all resolve
to empty strings, and the caller simply renders no location.
"""

from __future__ import annotations

import ipaddress
import logging
from functools import lru_cache

logger = logging.getLogger(__name__)

_reader = None
_reader_failed = False


def _get_reader():
    """Lazily construct the (singleton) GeoIP2Fast reader; cache failures too."""
    global _reader, _reader_failed
    if _reader is not None or _reader_failed:
        return _reader
    try:
        from geoip2fast import GeoIP2Fast

        _reader = GeoIP2Fast()
    except Exception as exc:  # library missing or DB unreadable
        logger.warning("geoip2fast unavailable; location lookups disabled: %s", exc)
        _reader_failed = True
    return _reader


@lru_cache(maxsize=8192)
def resolve_country(ip: str) -> tuple[str, str]:
    """Return ``(country_name, country_code)`` for a public IP.

    Returns ``("", "")`` for empty, private, loopback, reserved or
    unrecognisable addresses — i.e. anything we can't confidently geolocate.
    Cached, so repeated IPs in a result set are effectively free.
    """
    if not ip:
        return "", ""
    ip = ip.strip()
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return "", ""
    if addr.is_private or addr.is_loopback or addr.is_reserved or addr.is_link_local or addr.is_multicast:
        return "", ""

    reader = _get_reader()
    if reader is None:
        return "", ""
    try:
        result = reader.lookup(ip)
        code = (result.country_code or "").strip().upper()
        name = (result.country_name or "").strip()
        if len(code) == 2 and code.isalpha():
            return name, code
    except Exception:
        pass
    return "", ""
