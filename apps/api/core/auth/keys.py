"""JWT signing keys.

Access tokens are signed with **RS256** when ``JWT_PRIVATE_KEY`` is configured
(asymmetric — verifiers only need the public key / JWKS), and fall back to the
legacy **HS256** (Django ``SECRET_KEY``) when it isn't. This lets us roll out
asymmetric tokens without a flag day: issuers sign RS256, verifiers accept both
(see core/auth/jwt.py), and old HS256 access tokens keep validating for their
short lifetime.

``JWT_PRIVATE_KEY`` may be a PEM string or a base64-encoded PEM (handy for
single-line .env files).
"""

from __future__ import annotations

import base64
import functools
import hashlib

from django.conf import settings
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey


def _b64url_uint(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@functools.lru_cache(maxsize=1)
def _load() -> dict | None:
    raw = (getattr(settings, "JWT_PRIVATE_KEY", "") or "").strip()
    if not raw:
        return None
    pem = raw.encode() if "BEGIN" in raw else base64.b64decode(raw)
    private_key: RSAPrivateKey = serialization.load_pem_private_key(pem, password=None)
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    kid = hashlib.sha256(public_pem).hexdigest()[:16]
    nums = public_key.public_numbers()
    jwk = {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": kid,
        "n": _b64url_uint(nums.n),
        "e": _b64url_uint(nums.e),
    }
    return {
        "private_key": private_key,
        "public_key": public_key,
        "kid": kid,
        "jwk": jwk,
    }


def rsa_enabled() -> bool:
    return _load() is not None


def private_key():
    data = _load()
    return data["private_key"] if data else None


def public_key():
    data = _load()
    return data["public_key"] if data else None


def kid() -> str | None:
    data = _load()
    return data["kid"] if data else None


def jwks() -> dict:
    """JWKS document for the public verification key (empty when RS256 is off)."""
    data = _load()
    return {"keys": [data["jwk"]]} if data else {"keys": []}


def openid_configuration(issuer: str) -> dict:
    """OIDC-style discovery document so resource servers can auto-locate the
    JWKS + signing alg for token validation. We issue our own session/JWTs (not
    third-party OAuth2), so only the verification-relevant fields are populated.
    """
    issuer = issuer.rstrip("/")
    return {
        "issuer": issuer,
        "jwks_uri": f"{issuer}/.well-known/jwks.json",
        "id_token_signing_alg_values_supported": ["RS256"],
        "token_endpoint_auth_signing_alg_values_supported": ["RS256"],
        "response_types_supported": ["token"],
        "subject_types_supported": ["public"],
        "scopes_supported": ["openid", "email"],
        "claims_supported": ["sub", "email", "iss", "aud", "exp", "iat", "type"],
    }
