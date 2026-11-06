import { describe, expect, it } from "vitest";
import type { Member, OrgRole, UserContext } from "./identity";
import {
  type Viewer,
  formatJoined,
  inviteGate,
  inviteSummary,
  memberInitials,
  memberName,
  membersError,
  orgCan,
  ownerCount,
  removeGate,
  roleGate,
  roleOptionAllowed,
  transferCandidates,
  transferGate,
} from "./org-members";
import { orgSettingsHref } from "./org-settings";

const member = (id: string, role: OrgRole, name = `User ${id}`): Member => ({
  user: { id, email: `${id}@example.com`, name, avatar_url: "" },
  role,
  joined_at: "2026-10-01T12:00:00Z",
  last_login_at: null,
});

const viewer = (role: OrgRole, manage = role === "owner" || role === "admin"): Viewer => ({ id: "me", role, manage, invite: manage });

function context(role: OrgRole, capabilities: Record<string, string[]>, projects = ["shop"]): UserContext {
  return {
    user: { id: "me" } as UserContext["user"],
    orgs: [{ id: "o1", slug: "acme", name: "Acme", role, projects: projects.map((slug) => ({ id: slug, slug, name: slug, environments: [], app_count: 1 })) }],
    last_project_slug: null,
    onboarding: { step: null, completed: true },
    capabilities,
  } as UserContext;
}

describe("orgCan", () => {
  it("reads organization actions from any project's capabilities", () => {
    const ctx = context("viewer", { shop: ["project.read"], api: ["project.read", "members.invite"] }, ["shop", "api"]);
    expect(orgCan(ctx, "acme", "members.invite")).toBe(true);
    expect(orgCan(ctx, "acme", "members.remove")).toBe(false);
  });

  it("ignores the role when the organization has projects (the backend decides)", () => {
    expect(orgCan(context("owner", {}), "acme", "members.remove")).toBe(false);
  });

  it("falls back to the role for an organization without projects", () => {
    expect(orgCan(context("admin", {}, []), "acme", "members.remove")).toBe(true);
    expect(orgCan(context("viewer", {}, []), "acme", "members.invite")).toBe(false);
    expect(orgCan(context("owner", {}, []), "acme", "billing.manage")).toBe(false);
  });

  it("denies an unknown organization", () => {
    expect(orgCan(context("owner", { shop: ["members.invite"] }), "other", "members.invite")).toBe(false);
  });
});

describe("gates", () => {
  const owner = member("o", "owner");
  const admin = member("a", "admin");
  const plain = member("m", "member");

  it("lets admins manage members and admins but not owners", () => {
    const v = viewer("admin");
    expect(roleGate(v, plain, 2)).toEqual({ allowed: true });
    expect(roleGate(v, admin, 2)).toEqual({ allowed: true });
    expect(roleGate(v, owner, 2)).toEqual({ allowed: false, reason: "Only owners can change an owner’s role." });
    expect(removeGate(v, owner, 2)).toEqual({ allowed: false, reason: "Only owners can remove an owner." });
    expect(roleOptionAllowed(v, "owner")).toBe(false);
    expect(roleOptionAllowed(v, "admin")).toBe(true);
  });

  it("keeps the last owner", () => {
    const v = viewer("owner");
    expect(roleGate(v, owner, 1)).toEqual({ allowed: false, reason: "An organization needs at least one owner." });
    expect(removeGate(v, owner, 1).allowed).toBe(false);
    expect(roleGate(v, owner, 2).allowed).toBe(true);
    expect(roleOptionAllowed(v, "owner")).toBe(true);
  });

  it("never touches the viewer's own row", () => {
    const v = viewer("owner");
    expect(roleGate(v, member("me", "owner"), 2)).toEqual({ allowed: false, reason: "You can’t change your own role." });
    expect(removeGate(v, member("me", "owner"), 2)).toEqual({ allowed: false, reason: "You can’t remove yourself." });
  });

  it("disables everything for members and viewers without the capability", () => {
    const v = viewer("viewer");
    expect(roleGate(v, plain, 1)).toEqual({ allowed: false, reason: "Only owners and admins can change roles." });
    expect(removeGate(v, plain, 1)).toEqual({ allowed: false, reason: "Only owners and admins can remove members." });
    expect(inviteGate(v)).toEqual({ allowed: false, reason: "Only owners and admins can invite people." });
    expect(inviteGate(viewer("admin"))).toEqual({ allowed: true });
  });

  it("lets only owners transfer, to someone who is not already an owner", () => {
    const members = [member("me", "owner"), owner, admin, plain];
    expect(transferCandidates(viewer("owner"), members).map((m) => m.user.id)).toEqual(["a", "m"]);
    expect(transferGate(viewer("owner"), members)).toEqual({ allowed: true });
    expect(transferGate(viewer("admin"), members)).toEqual({ allowed: false, reason: "Only owners can transfer ownership." });
    expect(transferGate(viewer("owner"), [member("me", "owner")]).allowed).toBe(false);
  });

  it("counts owners", () => {
    expect(ownerCount([owner, admin, member("x", "owner")])).toBe(2);
  });
});

describe("display", () => {
  it("names and initials", () => {
    expect(memberName(member("a", "admin", "Ada Lovelace"))).toBe("Ada Lovelace");
    expect(memberName(member("a", "admin", "  "))).toBe("a@example.com");
    expect(memberInitials(member("a", "admin", "Ada King Lovelace"))).toBe("AL");
    expect(memberInitials(member("a", "admin", "ada"))).toBe("AD");
    expect(memberInitials(member("b", "admin", ""))).toBe("B");
  });

  it("formats the join date in UTC", () => {
    expect(formatJoined("2026-10-31T23:30:00Z")).toBe("Oct 31, 2026");
    expect(formatJoined("nope")).toBe("Unknown");
  });

  it("links the settings sections", () => {
    expect(orgSettingsHref("acme", { slug: "" })).toBe("/orgs/acme/settings");
    expect(orgSettingsHref("acme", { slug: "members" })).toBe("/orgs/acme/settings/members");
    expect(orgSettingsHref("acme", { slug: "invitations" })).toBe("/orgs/acme/settings/invitations");
  });
});

describe("invites", () => {
  it("summarizes the results", () => {
    expect(inviteSummary([{ email: "a@example.com", status: "invited" }])).toBe("Sent 1 invitation.");
    expect(
      inviteSummary([
        { email: "a@example.com", status: "invited" },
        { email: "b@example.com", status: "replaced" },
        { email: "c@example.com", status: "already_member" },
      ]),
    ).toBe("Sent 2 invitations. c@example.com is already a member.");
    expect(inviteSummary([{ email: "c@example.com", status: "already_member" }, { email: "d@example.com", status: "already_member" }])).toBe(
      "c@example.com, d@example.com are already members.",
    );
    expect(inviteSummary([])).toBe("No invitations were sent.");
  });
});

describe("membersError", () => {
  it("has a sentence for every documented code", () => {
    for (const code of ["last_owner", "member_gone", "forbidden", "not_found", "invalid_request", "authz_unavailable"]) {
      expect(membersError(code)).not.toBe(membersError("whatever"));
    }
  });
});
