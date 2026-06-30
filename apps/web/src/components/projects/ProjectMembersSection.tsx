"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, UserPlus, Trash2, Mail, LogOut, Crown } from "lucide-react";
import SettingsCard from "@/components/settings/SettingsCard";
import ConfirmDialog from "@/components/settings/ConfirmDialog";

type Role = "owner" | "admin" | "member" | "viewer";

interface Member {
  id: string | null;
  user_id: string;
  email: string;
  name: string;
  role: Role;
  is_owner: boolean;
  is_you: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  created_at: string;
}

interface MembersData {
  members: Member[];
  invitations: Invitation[];
  your_role: Role;
}

interface ProjectMembersSectionProps {
  projectSlug: string;
  showToast: (type: "success" | "error", message: string) => void;
}

const ASSIGNABLE_ROLES: { value: Role; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full control, including deleting the project",
  admin: "Manage members, keys, and settings",
  member: "Read and write project data",
  viewer: "Read-only access",
};

function initials(name: string, email: string): string {
  const source = (name || email || "?").trim();
  const parts = source.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export default function ProjectMembersSection({ projectSlug, showToast }: ProjectMembersSectionProps) {
  const [data, setData] = useState<MembersData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [isInviting, setIsInviting] = useState(false);

  const [savingMemberId, setSavingMemberId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectSlug}/members`);
      if (!res.ok) throw new Error("Failed to load members");
      setData(await res.json());
    } catch (err) {
      if (!(err instanceof DOMException)) console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  const canManage = data?.your_role === "owner" || data?.your_role === "admin";

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setIsInviting(true);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to send invitation");
      setInviteEmail("");
      setInviteRole("member");
      showToast("success", `Invitation sent to ${email}`);
      await fetchMembers();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to send invitation");
    } finally {
      setIsInviting(false);
    }
  };

  const handleRoleChange = async (member: Member, role: Role) => {
    if (!member.id) return;
    setSavingMemberId(member.id);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to update role");
      setData((prev) =>
        prev
          ? { ...prev, members: prev.members.map((m) => (m.id === member.id ? { ...m, role } : m)) }
          : prev,
      );
      showToast("success", `${member.name || member.email} is now ${role}`);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setSavingMemberId(null);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget?.id) return;
    setIsMutating(true);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/members/${removeTarget.id}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to remove member");
      const wasYou = removeTarget.is_you;
      showToast("success", wasYou ? "You left the project" : "Member removed");
      if (wasYou) {
        window.location.href = "/projects";
        return;
      }
      setData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.id !== removeTarget.id) } : prev,
      );
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to remove member");
    } finally {
      setIsMutating(false);
      setRemoveTarget(null);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setIsMutating(true);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/invitations/${revokeTarget.id}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to revoke invitation");
      setData((prev) =>
        prev
          ? { ...prev, invitations: prev.invitations.filter((i) => i.id !== revokeTarget.id) }
          : prev,
      );
      showToast("success", "Invitation revoked");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to revoke invitation");
    } finally {
      setIsMutating(false);
      setRevokeTarget(null);
    }
  };

  return (
    <>
      {canManage && (
        <SettingsCard
          title="Invite a teammate"
          description="They'll get an email invitation. If they don't have an account yet, one is created when they sign in."
        >
          <form onSubmit={handleInvite} className="members-invite-form">
            <input
              type="email"
              className="apikeys-input"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              autoComplete="off"
            />
            <select
              className="members-role-select"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Role)}
              aria-label="Role"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="settings-btn settings-btn-primary settings-btn-sm"
              disabled={isInviting || !inviteEmail.trim()}
            >
              {isInviting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <UserPlus size={14} />
                  Invite
                </>
              )}
            </button>
          </form>
          <p className="members-role-hint">{ROLE_DESCRIPTIONS[inviteRole]}</p>
        </SettingsCard>
      )}

      <SettingsCard
        title="Members"
        description="People with access to this project and their roles."
      >
        {isLoading ? (
          <div className="sessions-loading">
            <Loader2 size={18} className="animate-spin" />
            <span>Loading members...</span>
          </div>
        ) : (
          <div className="project-apikeys-list">
            {data?.members.map((m) => (
              <div key={m.user_id} className="project-apikey-row">
                <div className="project-apikey-main">
                  <div className="members-avatar">{initials(m.name, m.email)}</div>
                  <div className="apikeys-item-info">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <p className="apikeys-item-name">{m.name || m.email}</p>
                      {m.is_you && <span className="members-you-badge">You</span>}
                    </div>
                    <p className="apikeys-item-subtitle">{m.email}</p>
                  </div>
                </div>

                <div className="project-apikey-row-action members-row-action">
                  {m.is_owner ? (
                    <span className="members-role-badge members-role-owner">
                      <Crown size={12} />
                      Owner
                    </span>
                  ) : canManage ? (
                    <select
                      className="members-role-select"
                      value={m.role}
                      disabled={savingMemberId === m.id}
                      onChange={(e) => handleRoleChange(m, e.target.value as Role)}
                      aria-label={`Role for ${m.email}`}
                    >
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="members-role-badge">
                      {m.role.charAt(0).toUpperCase() + m.role.slice(1)}
                    </span>
                  )}

                  {!m.is_owner && (canManage || m.is_you) && (
                    <button
                      className="settings-btn settings-btn-ghost settings-btn-sm"
                      onClick={() => setRemoveTarget(m)}
                      aria-label={m.is_you ? "Leave project" : `Remove ${m.email}`}
                    >
                      {m.is_you ? <LogOut size={14} /> : <Trash2 size={14} />}
                      {m.is_you ? "Leave" : "Remove"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      {canManage && data && data.invitations.length > 0 && (
        <SettingsCard
          title="Pending invitations"
          description="People who've been invited but haven't joined yet."
        >
          <div className="project-apikeys-list">
            {data.invitations.map((inv) => (
              <div key={inv.id} className="project-apikey-row">
                <div className="project-apikey-main">
                  <div className="members-avatar members-avatar-pending">
                    <Mail size={15} />
                  </div>
                  <div className="apikeys-item-info">
                    <p className="apikeys-item-name">{inv.email}</p>
                    <p className="apikeys-item-subtitle">
                      Invited as {inv.role} · Expires {new Date(inv.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  </div>
                </div>
                <div className="project-apikey-row-action members-row-action">
                  <span className="members-role-badge members-role-pending">Pending</span>
                  <button
                    className="settings-btn settings-btn-ghost settings-btn-sm"
                    onClick={() => setRevokeTarget(inv)}
                    aria-label={`Revoke invitation for ${inv.email}`}
                  >
                    <Trash2 size={14} />
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}

      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={handleRemove}
        title={removeTarget?.is_you ? "Leave project" : "Remove member"}
        description={
          removeTarget?.is_you
            ? "You'll lose access to this project. The owner can re-invite you."
            : `Remove ${removeTarget?.name || removeTarget?.email} from this project? They'll immediately lose access.`
        }
        confirmText={removeTarget?.is_you ? "Leave" : "Remove"}
        variant="danger"
        isLoading={isMutating}
      />

      <ConfirmDialog
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke invitation"
        description={`Revoke the invitation for ${revokeTarget?.email}? The invite link will stop working.`}
        confirmText="Revoke"
        variant="danger"
        isLoading={isMutating}
      />
    </>
  );
}
