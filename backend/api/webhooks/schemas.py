"""
Schemas for webhook endpoints.
"""

from typing import Optional
from ninja import Schema


class Auth0UserSyncRequest(Schema):
    """
    Payload from Auth0 Post-Login Action.

    Only includes fields we actually use to minimize payload size.
    """
    user_id: str  # Auth0 sub claim (e.g., "google-oauth2|123")
    email: str
    name: Optional[str] = None
    picture: Optional[str] = None
    email_verified: bool = False
    connection: Optional[str] = None  # google-oauth2, apple, Username-Password-Authentication


class Auth0UserSyncResponse(Schema):
    """Response for user sync webhook."""
    success: bool
    user_id: str  # Django user UUID
    created: bool  # True if new user, False if existing
    message: str
