// Shared (server + client) permission vocabulary. The UI never decides what a
// user may do: the backend (OPA) returns the caller's allowed actions for the
// active project with the page data. UI gating is UX only; the server enforces.

export type Action =
  | "project.read"
  | "project.update"
  | "project.delete"
  | "members.invite"
  | "members.remove"
  | "api_keys.create"
  | "api_keys.revoke"
  | "billing.manage";

export type Role = "owner" | "admin" | "member" | "viewer";

/** Display labels: sentence case comes from data, not a CSS transform. */
export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

/** Lowest role that can perform each action; drives the "ask an admin" copy. */
export const REQUIRED_ROLE: Record<Action, Role> = {
  "project.read": "viewer",
  "project.update": "admin",
  "project.delete": "owner",
  "members.invite": "admin",
  "members.remove": "admin",
  "api_keys.create": "admin",
  "api_keys.revoke": "admin",
  "billing.manage": "owner",
};

/** Demo capability sets. Real ones come from the backend with the page data. */
export function actionsFor(role: Role): Action[] {
  const byRole: Record<Role, Action[]> = {
    owner: Object.keys(REQUIRED_ROLE) as Action[],
    admin: ["project.read", "project.update", "members.invite", "members.remove", "api_keys.create", "api_keys.revoke"],
    member: ["project.read", "api_keys.create"],
    viewer: ["project.read"],
  };
  return byRole[role];
}
