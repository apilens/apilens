"""
Tenant context for multi-tenant authentication.
"""

from dataclasses import dataclass, field


@dataclass
class TenantContext:
    """
    Context object attached to requests after authentication.
    Contains tenant and user information extracted from JWT.
    """

    tenant_id: str
    user_id: str
    email: str
    role: str = "member"
    permissions: list[str] = field(default_factory=list)

    def has_permission(self, permission: str) -> bool:
        """Check if the user has a specific permission."""
        if self.is_admin():
            return True
        return permission in self.permissions

    def is_admin(self) -> bool:
        """Check if the user has admin role."""
        return self.role in ("admin", "owner")

    def is_owner(self) -> bool:
        """Check if the user is the tenant owner."""
        return self.role == "owner"

    def can_read(self) -> bool:
        """Check if user can read resources."""
        return self.has_permission("read") or self.is_admin()

    def can_write(self) -> bool:
        """Check if user can write/modify resources."""
        return self.has_permission("write") or self.is_admin()

    def can_delete(self) -> bool:
        """Check if user can delete resources."""
        return self.has_permission("delete") or self.is_admin()
