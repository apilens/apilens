import ipaddress
import logging

import httpx

logger = logging.getLogger(__name__)

_PRIVATE_RESULT = "Local network"


def _is_private(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_private or ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def resolve_location(ip: str | None) -> str:
    if not ip:
        return ""

    if _is_private(ip):
        return _PRIVATE_RESULT

    try:
        resp = httpx.get(
            f"http://ip-api.com/json/{ip}",
            params={"fields": "city,country"},
            timeout=2.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            city = data.get("city", "")
            country = data.get("country", "")
            if city and country:
                return f"{city}, {country}"
            return country or city or ""
    except Exception:
        logger.debug("GeoIP lookup failed for %s", ip, exc_info=True)

    return ""
