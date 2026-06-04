"""
Django base settings for apilens project.
"""

import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv()

SECRET_KEY = os.environ.get(
    "DJANGO_SECRET_KEY",
    "django-insecure-change-me-in-production"
)

# RSA private key (PEM, or base64-encoded PEM) for signing access tokens with
# RS256 + a JWKS endpoint. When empty, JWT signing falls back to HS256 with
# SECRET_KEY (see core/auth/keys.py + core/auth/jwt.py).
JWT_PRIVATE_KEY = os.environ.get("JWT_PRIVATE_KEY", "")

DEBUG = os.environ.get("DJANGO_DEBUG", "False").lower() in ("true", "1", "yes")

ALLOWED_HOSTS = [
    host.strip()
    for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if host.strip()
]
# Allow ngrok domains for development only
if DEBUG:
    ALLOWED_HOSTS += [".ngrok-free.app", ".ngrok.io"]

if not DEBUG and SECRET_KEY == "django-insecure-change-me-in-production":
    raise RuntimeError("DJANGO_SECRET_KEY must be set to a strong value in production")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "corsheaders",
    "ninja",
    # Local apps
    "apps.users",
    "apps.auth",
    "apps.projects",
    "apps.endpoints",  # stub — kept for migration history only
]

# Custom User Model
AUTH_USER_MODEL = "users.User"

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

# Security hardening (safe defaults for production)
if not DEBUG:
    SECURE_SSL_REDIRECT = os.environ.get("DJANGO_SECURE_SSL_REDIRECT", "True").lower() in ("true", "1", "yes")
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_SECURE_HSTS_SECONDS", "31536000"))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = os.environ.get("DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS", "True").lower() in ("true", "1", "yes")
    SECURE_HSTS_PRELOAD = os.environ.get("DJANGO_SECURE_HSTS_PRELOAD", "True").lower() in ("true", "1", "yes")
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
else:
    SECURE_SSL_REDIRECT = False
    SECURE_HSTS_SECONDS = 0
    SECURE_HSTS_INCLUDE_SUBDOMAINS = False
    SECURE_HSTS_PRELOAD = False

SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# Origins trusted for unsafe (POST/PUT/...) requests — required for the Django
# admin + form logins when served behind an HTTPS reverse proxy on a real
# domain. Comma-separated, scheme-qualified, e.g. "https://app.apilens.ai".
CSRF_TRUSTED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",")
    if origin.strip()
]

# CORS Configuration
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if origin.strip()
]
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_HEADERS = [
    "accept",
    "accept-encoding",
    "authorization",
    "content-type",
    "dnt",
    "origin",
    "user-agent",
    "x-csrftoken",
    "x-requested-with",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"


database_url = os.environ.get("APILENS_DATABASE_URL", "").strip()
if not database_url:
    database_url = (
        os.environ.get("APILENS_POSTGRES_URL", "").strip()
        or os.environ.get("APILENS_DATABASE_URL_UNPOOLED", "").strip()
        or os.environ.get("APILENS_POSTGRES_URL_NON_POOLING", "").strip()
    )

if database_url:
    parsed = urlparse(database_url)
    query = parse_qs(parsed.query)
    db_options = {"connect_timeout": 10}
    if "sslmode" in query and query["sslmode"]:
        db_options["sslmode"] = query["sslmode"][-1]

    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": (parsed.path or "").lstrip("/") or "postgres",
            "USER": unquote(parsed.username or ""),
            "PASSWORD": unquote(parsed.password or ""),
            "HOST": parsed.hostname or "localhost",
            "PORT": str(parsed.port or "5432"),
            "CONN_MAX_AGE": 60,
            "OPTIONS": db_options,
        }
    }
else:
    db_name = (
        os.environ.get("APILENS_POSTGRES_DATABASE")
        or os.environ.get("APILENS_PGDATABASE")
        or os.environ.get("POSTGRES_DB")
        or "postgres"
    )
    db_user = (
        os.environ.get("APILENS_POSTGRES_USER")
        or os.environ.get("APILENS_PGUSER")
        or os.environ.get("POSTGRES_USER")
        or "postgres"
    )
    db_password = (
        os.environ.get("APILENS_POSTGRES_PASSWORD")
        or os.environ.get("APILENS_PGPASSWORD")
        or os.environ.get("POSTGRES_PASSWORD")
        or "apilens_password"
    )
    db_host = (
        os.environ.get("APILENS_POSTGRES_HOST")
        or os.environ.get("APILENS_PGHOST")
        or os.environ.get("POSTGRES_HOST")
        or "localhost"
    )
    db_port = (
        os.environ.get("APILENS_POSTGRES_PORT")
        or os.environ.get("APILENS_PGPORT")
        or os.environ.get("POSTGRES_PORT")
        or "5432"
    )

    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": db_name,
            "USER": db_user,
            "PASSWORD": db_password,
            "HOST": db_host,
            "PORT": db_port,
            "CONN_MAX_AGE": 60,
            "OPTIONS": {
                "connect_timeout": 10,
            },
        }
    }

# Frontend URL (for magic link emails)
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")

# WebAuthn / passkey config.
# RPID is the domain the browser binds the credential to. It must equal the
# origin's effective domain, OR a registrable parent (e.g. `apilens.ai` works
# for `app.apilens.ai`, `docs.apilens.ai`, etc. — useful for cross-subdomain).
# Locally we use `localhost` so dev passkeys work without HTTPS.
WEBAUTHN_RP_ID = os.environ.get("WEBAUTHN_RP_ID", "localhost")
WEBAUTHN_RP_NAME = os.environ.get("WEBAUTHN_RP_NAME", "API Lens")

# Email Configuration
EMAIL_BACKEND = os.environ.get(
    "EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend"
)
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "noreply@apilens.io")
EMAIL_HOST = os.environ.get("EMAIL_HOST", "")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = os.environ.get("EMAIL_USE_TLS", "True").lower() in ("true", "1", "yes")

# ClickHouse Configuration (analytics/event store)
clickhouse_url = os.environ.get("APILENS_CLICKHOUSE_URL", "").strip() or os.environ.get("CLICKHOUSE_URL", "").strip()
if clickhouse_url:
    ch_parsed = urlparse(clickhouse_url)
    ch_scheme = (ch_parsed.scheme or "").lower()
    ch_secure = ch_scheme in {"https", "clickhouses"}
    CLICKHOUSE = {
        "HOST": ch_parsed.hostname or "localhost",
        "PORT": int(ch_parsed.port or (8443 if ch_secure else 9000)),
        "DATABASE": (ch_parsed.path or "").lstrip("/") or "default",
        "USER": unquote(ch_parsed.username or "default"),
        "PASSWORD": unquote(ch_parsed.password or ""),
        "SECURE": ch_secure,
        "VERIFY": os.environ.get("APILENS_CLICKHOUSE_VERIFY", "True").lower() in ("true", "1", "yes"),
    }
else:
    CLICKHOUSE = {
        "HOST": os.environ.get("APILENS_CLICKHOUSE_HOST", os.environ.get("CLICKHOUSE_HOST", "localhost")),
        "PORT": int(os.environ.get("APILENS_CLICKHOUSE_PORT", os.environ.get("CLICKHOUSE_PORT", "9000"))),
        "DATABASE": os.environ.get("APILENS_CLICKHOUSE_DATABASE", os.environ.get("CLICKHOUSE_DATABASE", "apilens")),
        "USER": os.environ.get("APILENS_CLICKHOUSE_USER", os.environ.get("CLICKHOUSE_USER", "default")),
        "PASSWORD": os.environ.get("APILENS_CLICKHOUSE_PASSWORD", os.environ.get("CLICKHOUSE_PASSWORD", "")),
        "SECURE": os.environ.get("APILENS_CLICKHOUSE_SECURE", "False").lower() in ("true", "1", "yes"),
        "VERIFY": os.environ.get("APILENS_CLICKHOUSE_VERIFY", "True").lower() in ("true", "1", "yes"),
    }

CLICKHOUSE_RETRY_COOLDOWN_SECONDS = float(
    os.environ.get("APILENS_CLICKHOUSE_RETRY_COOLDOWN_SECONDS", "10")
)

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]


LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True


STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Media (user uploads): GCS in production, local filesystem in dev.
# Production sets `GS_BUCKET_NAME=<project>-media` on the VM; locally the
# env var is unset and uploads land in backend/media/ as before.
GS_BUCKET_NAME = os.environ.get("GS_BUCKET_NAME", "").strip()

if GS_BUCKET_NAME:
    MEDIA_URL = f"https://storage.googleapis.com/{GS_BUCKET_NAME}/"
    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.gcloud.GoogleCloudStorage",
            "OPTIONS": {
                "bucket_name": GS_BUCKET_NAME,
                "default_acl": None,  # bucket has uniform IAM; per-object ACLs are off
                "querystring_auth": False,  # public bucket — emit clean URLs
                "object_parameters": {
                    "cache_control": "public, max-age=31536000",
                },
            },
        },
        "staticfiles": {
            "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
        },
    }
else:
    MEDIA_URL = "/media/"
    MEDIA_ROOT = BASE_DIR / "media"
    STORAGES = {
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
        "staticfiles": {
            "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
        },
    }

# Profile picture constraints
PROFILE_PICTURE_MAX_SIZE = 5 * 1024 * 1024  # 5 MB
PROFILE_PICTURE_MAX_DIMENSION = 800  # pixels
APP_ICON_MAX_SIZE = 2 * 1024 * 1024  # 2 MB
APP_ICON_MAX_DIMENSION = 512  # pixels

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Logging
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
        },
    },
    "root": {
        "handlers": ["console"],
        "level": "INFO",
    },
    "loggers": {
        "django": {
            "handlers": ["console"],
            "level": "INFO",
            "propagate": False,
        },
        "clickhouse_driver": {
            "handlers": ["console"],
            "level": "CRITICAL",
            "propagate": False,
        },
    },
}

# ---------------------------------------------------------------------------
# Sentry — full observability: errors + tracing + profiling + logs
# ---------------------------------------------------------------------------
# Active ONLY when SENTRY_DSN is set. In prod the DSN is injected from GCP Secret
# Manager into the container env (startup.sh -> .env); it is intentionally NOT
# committed to this repo. With no DSN (CI, or local without a DSN) this whole
# block is a no-op. Set SENTRY_DSN in apps/api/.env to enable it locally too —
# the environment is auto-tagged "development" when DEBUG is on.
SENTRY_DSN = os.environ.get("SENTRY_DSN", "").strip()
if SENTRY_DSN:
    import logging as _logging

    import sentry_sdk
    from sentry_sdk.integrations.logging import LoggingIntegration


    def _sentry_bool(name, default):
        return os.environ.get(name, default).lower() in ("true", "1", "yes")

    def _sentry_level(name, default):
        return getattr(_logging, os.environ.get(name, default).upper(), _logging.INFO)

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        # The Django integration auto-enables (unhandled exceptions, request
        # context, DB/cache/template spans). environment defaults to
        # "development" in DEBUG, else "production"; override with SENTRY_ENVIRONMENT.
        environment=os.environ.get("SENTRY_ENVIRONMENT")
        or ("development" if DEBUG else "production"),
        release=os.environ.get("SENTRY_RELEASE") or None,
        # --- Performance tracing --- fraction of requests traced (0.0–1.0).
        # Default 1.0 = trace everything; lower it (e.g. 0.2) to save quota.
        traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "1.0")),
        # --- Profiling --- fraction of traced transactions profiled (CPU/line).
        profiles_sample_rate=float(
            os.environ.get("SENTRY_PROFILES_SAMPLE_RATE", "1.0")
        ),
        # --- Structured logs (Sentry "Logs") --- forward Python logging to Sentry.
        enable_logs=_sentry_bool("SENTRY_ENABLE_LOGS", "True"),
        integrations=[
            LoggingIntegration(
                # >= this level recorded as breadcrumbs on events
                level=_sentry_level("SENTRY_BREADCRUMB_LEVEL", "INFO"),
                # >= this level also captured as standalone Sentry issues
                event_level=_sentry_level("SENTRY_EVENT_LEVEL", "ERROR"),
                # >= this level forwarded to the Sentry Logs product
                sentry_logs_level=_sentry_level("SENTRY_LOGS_LEVEL", "INFO"),
            ),
        ],
        # Attach user/email/request data. Set SENTRY_SEND_PII=False to scrub PII.
        send_default_pii=_sentry_bool("SENTRY_SEND_PII", "True"),
    )
