"""
Slug validation utilities for projects and apps.
Prevents conflicts with route paths and reserved keywords.
"""

from core.exceptions.base import ValidationError

# Reserved slugs that conflict with frontend routes or API endpoints
RESERVED_PROJECT_SLUGS = {
    # Frontend routes
    "new",
    "create",
    "settings",
    "api",
    "apps",
    "projects",

    # Common system paths
    "admin",
    "dashboard",
    "auth",
    "login",
    "logout",
    "signup",
    "register",

    # API-related
    "v1",
    "v2",
    "graphql",
    "webhooks",

    # Documentation/support
    "docs",
    "help",
    "support",
    "blog",
    "about",

    # System/internal
    "static",
    "media",
    "assets",
    "public",
    "private",
    "internal",
    "system",
    "config",
}

RESERVED_APP_SLUGS = {
    # Frontend routes (app-level)
    "new",
    "create",
    "settings",
    "setup",
    "general",
    "api-keys",
    "webhooks",
    "team",
    "billing",

    # Analytics/monitoring routes
    "endpoints",
    "logs",
    "analytics",
    "consumers",
    "monitors",
    "alerts",
    "metrics",

    # System
    "admin",
    "test",
    "staging",
    "production",
}


def validate_project_slug(slug: str) -> None:
    """
    Validate that a project slug is not reserved.

    Note: This validates the final slugified form, not the original input.
    slugify() will have already removed leading/trailing special characters.

    Args:
        slug: The slugified slug to validate

    Raises:
        ValidationError: If the slug is reserved or invalid
    """
    if not slug:
        raise ValidationError("Project name must contain at least one alphanumeric character")

    if slug.lower() in RESERVED_PROJECT_SLUGS:
        raise ValidationError(
            f"'{slug}' is a reserved name and cannot be used. "
            f"Please choose a different name."
        )

    # Validate length
    if len(slug) > 100:
        raise ValidationError("Project name is too long (max 100 characters)")

    # Check for double dashes (slugify converts underscores to dashes)
    if "--" in slug:
        raise ValidationError("Project name cannot contain consecutive dashes or special characters")


def validate_app_slug(slug: str, project_slug: str = None) -> None:
    """
    Validate that an app slug is not reserved.

    Note: This validates the final slugified form, not the original input.
    slugify() will have already removed leading/trailing special characters.

    Args:
        slug: The slugified slug to validate
        project_slug: Optional project slug for context-aware validation

    Raises:
        ValidationError: If the slug is reserved or invalid
    """
    if not slug:
        raise ValidationError("App name must contain at least one alphanumeric character")

    if slug.lower() in RESERVED_APP_SLUGS:
        raise ValidationError(
            f"'{slug}' is a reserved name and cannot be used. "
            f"Please choose a different name."
        )

    # Validate length
    if len(slug) > 100:
        raise ValidationError("App name is too long (max 100 characters)")

    # Check for double dashes (slugify converts underscores to dashes)
    if "--" in slug:
        raise ValidationError("App name cannot contain consecutive dashes or special characters")


def is_slug_reserved(slug: str, slug_type: str = "project") -> bool:
    """
    Check if a slug is reserved without raising an exception.

    Args:
        slug: The slug to check
        slug_type: Either "project" or "app"

    Returns:
        True if the slug is reserved, False otherwise
    """
    reserved_set = RESERVED_PROJECT_SLUGS if slug_type == "project" else RESERVED_APP_SLUGS
    return slug.lower() in reserved_set
