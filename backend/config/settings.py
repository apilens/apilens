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

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

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
    },
}
