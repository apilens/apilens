"""
Django production settings for apilens project.
"""

import os

from .base import *  # noqa: F401, F403

# =============================================================================
# Production Overrides
# =============================================================================

DEBUG = False

ALLOWED_HOSTS = [
    host.strip()
    for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",")
    if host.strip()
]

# =============================================================================
# Security Settings
# =============================================================================

# HTTPS settings
SECURE_SSL_REDIRECT = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Session security
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"

# CSRF security
CSRF_COOKIE_SECURE = True
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Lax"

# HSTS settings
SECURE_HSTS_SECONDS = 31536000  # 1 year
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True

# Other security settings
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_BROWSER_XSS_FILTER = True
X_FRAME_OPTIONS = "DENY"

# =============================================================================
# Static Files Configuration
# =============================================================================

STATIC_ROOT = BASE_DIR / "staticfiles"  # noqa: F405

# WhiteNoise for serving static files (optional)
# STATICFILES_STORAGE = "whitenoise.storage.CompressedManifestStaticFilesStorage"

# =============================================================================
# Sentry Configuration (Error Tracking)
# =============================================================================

SENTRY_DSN = os.environ.get("SENTRY_DSN", "")

if SENTRY_DSN:
    import sentry_sdk
    from sentry_sdk.integrations.django import DjangoIntegration
    from sentry_sdk.integrations.celery import CeleryIntegration
    from sentry_sdk.integrations.redis import RedisIntegration

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        integrations=[
            DjangoIntegration(),
            CeleryIntegration(),
            RedisIntegration(),
        ],
        environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
        traces_sample_rate=0.1,
        send_default_pii=False,
    )

# =============================================================================
# AWS S3 Configuration (for static/media files)
# =============================================================================

AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
AWS_STORAGE_BUCKET_NAME = os.environ.get("AWS_STORAGE_BUCKET_NAME", "")
AWS_S3_REGION_NAME = os.environ.get("AWS_S3_REGION_NAME", "us-east-1")

if AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY and AWS_STORAGE_BUCKET_NAME:
    AWS_S3_CUSTOM_DOMAIN = f"{AWS_STORAGE_BUCKET_NAME}.s3.amazonaws.com"
    AWS_DEFAULT_ACL = "public-read"
    AWS_S3_OBJECT_PARAMETERS = {"CacheControl": "max-age=86400"}

    # Static files
    STATICFILES_STORAGE = "storages.backends.s3boto3.S3Boto3Storage"
    STATIC_URL = f"https://{AWS_S3_CUSTOM_DOMAIN}/static/"

    # Media files
    DEFAULT_FILE_STORAGE = "storages.backends.s3boto3.S3Boto3Storage"
    MEDIA_URL = f"https://{AWS_S3_CUSTOM_DOMAIN}/media/"

# =============================================================================
# Email Configuration
# =============================================================================

EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = os.environ.get("EMAIL_HOST", "smtp.sendgrid.net")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = os.environ.get("EMAIL_USE_TLS", "True").lower() in ("true", "1", "yes")
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "noreply@apilens.in")

# =============================================================================
# Logging Configuration (JSON format for production)
# =============================================================================

LOGGING["formatters"]["json"] = {  # noqa: F405
    "()": "django.utils.log.ServerFormatter",
    "format": "[{server_time}] {message}",
    "style": "{",
}

LOGGING["handlers"]["console"]["formatter"] = "json"  # noqa: F405
