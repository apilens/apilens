"""Project membership & invitations (RBAC collaboration).

The project `owner` is authoritative and never stored here; this module manages
collaborator membership (admin/member/viewer) and email invitations. Authorization
for management actions is delegated to OPA via ProjectService.authorize.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from core.exceptions.base import ConflictError, NotFoundError, ValidationError

from .models import Project, ProjectInvitation, ProjectMember
from .services import ProjectService

INVITE_LIFETIME = timedelta(days=7)
_MANAGE_ROLES = {ProjectMember.Role.OWNER, ProjectMember.Role.ADMIN}
# Roles an owner/admin may assign (never "owner" — ownership isn't transferable here).
_ASSIGNABLE = {
    ProjectMember.Role.ADMIN,
    ProjectMember.Role.MEMBER,
    ProjectMember.Role.VIEWER,
}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _display(user) -> str:
    return (user.get_full_name() or "").strip() or user.email


class MembershipService:
    # ── Reads ──────────────────────────────────────────────────────────
    @staticmethod
    def list_members(user, project: Project) -> dict:
        your_role = ProjectService.authorize(user, project, "read")

        owner = project.owner
        members = [
            {
                "id": None,
                "user_id": str(owner.id),
                "email": owner.email,
                "name": _display(owner),
                "role": ProjectMember.Role.OWNER,
                "is_owner": True,
                "is_you": owner.id == user.id,
            }
        ]
        for m in ProjectMember.objects.filter(project=project).select_related("user"):
            members.append(
                {
                    "id": str(m.id),
                    "user_id": str(m.user_id),
                    "email": m.user.email,
                    "name": _display(m.user),
                    "role": m.role,
                    "is_owner": False,
                    "is_you": m.user_id == user.id,
                }
            )

        invitations: list[dict] = []
        if your_role in _MANAGE_ROLES:
            for inv in ProjectInvitation.objects.filter(
                project=project, status=ProjectInvitation.Status.PENDING
            ):
                invitations.append(
                    {
                        "id": str(inv.id),
                        "email": inv.email,
                        "role": inv.role,
                        "expires_at": inv.expires_at,
                        "created_at": inv.created_at,
                    }
                )
        return {"members": members, "invitations": invitations, "your_role": your_role}

    # ── Mutations (owner/admin) ────────────────────────────────────────
    @staticmethod
    @transaction.atomic
    def invite_member(user, project: Project, email: str, role: str) -> ProjectInvitation:
        ProjectService.authorize(user, project, "admin")
        email = (email or "").lower().strip()
        if not email:
            raise ValidationError("Email is required")
        if role not in _ASSIGNABLE:
            raise ValidationError("Invalid role")
        if email == project.owner.email.lower():
            raise ConflictError("That person is the project owner")
        if ProjectMember.objects.filter(
            project=project, user__email__iexact=email
        ).exists():
            raise ConflictError("That person is already a member")

        # Replace any existing pending invite for this email on this project.
        ProjectInvitation.objects.filter(
            project=project, email=email, status=ProjectInvitation.Status.PENDING
        ).update(status=ProjectInvitation.Status.REVOKED)

        raw = secrets.token_urlsafe(48)
        invitation = ProjectInvitation.objects.create(
            project=project,
            email=email,
            role=role,
            token_hash=_hash(raw),
            invited_by=user,
            expires_at=timezone.now() + INVITE_LIFETIME,
        )

        from apps.auth.email import InvitationEmailService

        InvitationEmailService.send(invitation, raw_token=raw, inviter=user)
        return invitation

    @staticmethod
    def update_member_role(user, project: Project, member_id: str, role: str) -> ProjectMember:
        ProjectService.authorize(user, project, "admin")
        if role not in _ASSIGNABLE:
            raise ValidationError("Invalid role")
        member = ProjectMember.objects.filter(project=project, id=member_id).first()
        if member is None:
            raise NotFoundError("Member not found")
        member.role = role
        member.save(update_fields=["role", "updated_at"])
        return member

    @staticmethod
    def remove_member(user, project: Project, member_id: str) -> None:
        member = ProjectMember.objects.filter(project=project, id=member_id).first()
        if member is None:
            raise NotFoundError("Member not found")
        # Anyone may remove themselves (leave); removing others needs admin.
        if member.user_id != user.id:
            ProjectService.authorize(user, project, "admin")
        member.delete()

    @staticmethod
    def revoke_invitation(user, project: Project, invite_id: str) -> None:
        ProjectService.authorize(user, project, "admin")
        inv = ProjectInvitation.objects.filter(
            project=project, id=invite_id, status=ProjectInvitation.Status.PENDING
        ).first()
        if inv is None:
            raise NotFoundError("Invitation not found")
        inv.status = ProjectInvitation.Status.REVOKED
        inv.save(update_fields=["status"])

    # ── Invitee inbox (explicit accept / decline) ──────────────────────
    @staticmethod
    def list_pending_for_user(user) -> list[dict]:
        """Pending, non-expired invitations addressed to this user's email.

        Powers the notification bell. Invitations are NOT auto-accepted on login;
        the invitee must explicitly accept or decline each one.
        """
        invites = (
            ProjectInvitation.objects.filter(
                email__iexact=user.email, status=ProjectInvitation.Status.PENDING
            )
            .select_related("project", "invited_by")
            .order_by("-created_at")
        )
        out: list[dict] = []
        for inv in invites:
            if inv.is_expired:
                continue
            # An invite to a project you already own/belong to is noise — hide it.
            if inv.project.owner_id == user.id:
                continue
            out.append(
                {
                    "id": str(inv.id),
                    "project_name": inv.project.name,
                    "project_slug": inv.project.slug,
                    "role": inv.role,
                    "inviter": _display(inv.invited_by) if inv.invited_by else "",
                    "created_at": inv.created_at,
                    "expires_at": inv.expires_at,
                }
            )
        return out

    @staticmethod
    def _accept(inv: ProjectInvitation, user) -> Project:
        if inv.project.owner_id != user.id:
            ProjectMember.objects.get_or_create(
                project=inv.project,
                user=user,
                defaults={"role": inv.role, "invited_by": inv.invited_by},
            )
        inv.status = ProjectInvitation.Status.ACCEPTED
        inv.accepted_at = timezone.now()
        inv.save(update_fields=["status", "accepted_at"])
        return inv.project

    @staticmethod
    @transaction.atomic
    def accept_by_id(user, invite_id: str) -> Project:
        inv = (
            ProjectInvitation.objects.filter(
                id=invite_id, status=ProjectInvitation.Status.PENDING
            )
            .select_related("project")
            .first()
        )
        if inv is None or inv.is_expired:
            raise NotFoundError("Invitation is invalid or has expired")
        if inv.email.lower() != user.email.lower():
            raise NotFoundError("Invitation is invalid or has expired")
        return MembershipService._accept(inv, user)

    @staticmethod
    @transaction.atomic
    def accept_by_token(user, token: str) -> Project:
        inv = (
            ProjectInvitation.objects.filter(
                token_hash=_hash(token), status=ProjectInvitation.Status.PENDING
            )
            .select_related("project")
            .first()
        )
        if inv is None or inv.is_expired:
            raise NotFoundError("Invitation is invalid or has expired")
        if inv.email.lower() != user.email.lower():
            raise ValidationError("This invitation was sent to a different email address.")
        return MembershipService._accept(inv, user)

    @staticmethod
    def _decline(inv: ProjectInvitation) -> None:
        inv.status = ProjectInvitation.Status.DECLINED
        inv.save(update_fields=["status"])

    @staticmethod
    def decline_by_id(user, invite_id: str) -> None:
        inv = ProjectInvitation.objects.filter(
            id=invite_id, status=ProjectInvitation.Status.PENDING
        ).first()
        if inv is None:
            raise NotFoundError("Invitation not found")
        if inv.email.lower() != user.email.lower():
            raise NotFoundError("Invitation not found")
        MembershipService._decline(inv)

    @staticmethod
    def decline_by_token(user, token: str) -> None:
        inv = ProjectInvitation.objects.filter(
            token_hash=_hash(token), status=ProjectInvitation.Status.PENDING
        ).first()
        if inv is None:
            raise NotFoundError("Invitation not found")
        if inv.email.lower() != user.email.lower():
            raise ValidationError("This invitation was sent to a different email address.")
        MembershipService._decline(inv)

    @staticmethod
    def get_invitation_info(token: str) -> dict:
        inv = (
            ProjectInvitation.objects.filter(token_hash=_hash(token))
            .select_related("project", "invited_by")
            .first()
        )
        if (
            inv is None
            or inv.status != ProjectInvitation.Status.PENDING
            or inv.is_expired
        ):
            return {"valid": False}
        return {
            "valid": True,
            "email": inv.email,
            "role": inv.role,
            "project_name": inv.project.name,
            "project_slug": inv.project.slug,
            "inviter": _display(inv.invited_by) if inv.invited_by else "",
        }
