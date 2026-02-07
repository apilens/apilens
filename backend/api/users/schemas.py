"""
Pydantic schemas for User API.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from ninja import Schema


class UserProfileResponse(Schema):
    """User profile response schema."""
    id: UUID
    email: str
    first_name: str
    last_name: str
    display_name: str
    picture: str
    email_verified: bool
    provider: str
    created_at: datetime
    last_login_at: Optional[datetime] = None


class UserProfileUpdateRequest(Schema):
    """User profile update request schema."""
    first_name: Optional[str] = None
    last_name: Optional[str] = None


class UserContextResponse(Schema):
    """User context information for frontend."""
    id: UUID
    email: str
    display_name: str
    picture: str
    is_authenticated: bool = True
    permissions: list[str] = []
    role: str = "member"
