# syntax=docker/dockerfile:1
# ============================================================================
# APILens Identity (IAM) service image.
#
# Identity is NOT a separate codebase. It shares the Django `User` model and the
# Postgres database with the core API (`Project.owner` FKs `User`), so it reuses
# the backend image verbatim and only changes which urlconf Django loads:
#
#   ROOT_URLCONF=config.urls_identity  ->  bounded auth-only surface
#     (login, magic-link, passkey, TOTP/2FA, JWT issuance, JWKS, OIDC discovery)
#
# Projects / users / analytics are NOT exposed here — those stay on the core API
# (config.urls). The shared source of truth lives in apps/api; CI builds this
# image FROM the freshly-pushed backend image (the BACKEND_IMAGE build-arg), so
# there is exactly one copy of the auth code and zero drift.
#
# Everything else (entrypoint -> scripts/start.sh -> gunicorn config.wsgi,
# EXPOSE 8000, the venv, DJANGO_SETTINGS_MODULE) is inherited from the backend
# image unchanged.
# ============================================================================
ARG BACKEND_IMAGE
FROM ${BACKEND_IMAGE}

# Bound this container to the auth-only urlconf. config.urls_identity already
# ships inside the backend image (apps/api/config/urls_identity.py); we only
# flip the default ROOT_URLCONF so the identity container serves the IdP surface
# without any compose-level override.
ENV ROOT_URLCONF=config.urls_identity
