"""
Django development settings for apilens project.
"""

from .base import *  # noqa: F401, F403

# =============================================================================
# Development Overrides
# =============================================================================

DEBUG = True

ALLOWED_HOSTS = ["*"]

# =============================================================================
# CORS (Allow all origins in development)
# =============================================================================

CORS_ALLOW_ALL_ORIGINS = True

# =============================================================================
# Email Configuration (Console backend for development)
# =============================================================================

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# =============================================================================
# Cache Configuration (Use local memory cache in development)
# =============================================================================

# Optionally use simple cache for development without Redis
# CACHES = {
#     "default": {
#         "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
#         "LOCATION": "unique-snowflake",
#     }
# }

# =============================================================================
# Debug Toolbar (if installed)
# =============================================================================

try:
    import debug_toolbar  # noqa: F401

    INSTALLED_APPS += ["debug_toolbar"]  # noqa: F405
    MIDDLEWARE.insert(0, "debug_toolbar.middleware.DebugToolbarMiddleware")  # noqa: F405
    INTERNAL_IPS = ["127.0.0.1"]
except ImportError:
    pass

# =============================================================================
# Logging (More verbose in development)
# =============================================================================

LOGGING["loggers"]["django"]["level"] = "DEBUG"  # noqa: F405
LOGGING["loggers"]["api"]["level"] = "DEBUG"  # noqa: F405
LOGGING["loggers"]["core"]["level"] = "DEBUG"  # noqa: F405
