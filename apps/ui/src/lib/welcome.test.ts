import { describe, expect, it } from "vitest";
import type { ContextOrg, JoinableOrg, MyInvitation, UserContext } from "./identity";
import { FIRST_PROJECT, suggestedOrgName, welcomeCards } from "./welcome";

const org = (slug: string, name: string): ContextOrg => ({ id: `org_${slug}`, slug, name, role: "member", projects: [] });

function ctx(orgs: ContextOrg[] = []): UserContext {
  return {
    user: {
      id: "u1",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      avatar_url: null,
      preferences: {},
      onboarding: { step: "welcome", completed: false },
      created_at: "2026-11-01T00:00:00Z",
    },
    orgs,
    last_project_slug: null,
    onboarding: { step: "welcome", completed: false },
    capabilities: {},
  };
}

const invitation = (over: Partial<MyInvitation> = {}): MyInvitation => ({
  id: "inv1",
  org_slug: "globex",
  org_name: "Globex",
  role: "member",
  invited_by_name: "Olive Owner",
  expires_at: "2026-12-01T00:00:00Z",
  ...over,
});

const joinable = (over: Partial<JoinableOrg> = {}): JoinableOrg => ({
  id: "org_initech",
  slug: "initech",
  name: "Initech",
  member_count: 4,
  project_count: 2,
  member_initials: ["PG", "BL"],
  ...over,
});

describe("suggestedOrgName", () => {
  it("suggests an organization name from the first name", () => {
    expect(suggestedOrgName("Ada Lovelace")).toBe("Ada's org");
    expect(suggestedOrgName("  ada  ")).toBe("Ada's org");
    expect(suggestedOrgName("")).toBe("");
    expect(suggestedOrgName("Alexis")).toBe("Alexis' org");
  });

  it("suggests nothing when the first name gives no address", () => {
    // "张伟's org" would become the address `s-org`, from the possessive alone, and an
    // organization's address cannot be changed afterwards.
    expect(suggestedOrgName("张伟")).toBe("");
    expect(suggestedOrgName("张伟 Zhang")).toBe("");
    expect(suggestedOrgName("🙂")).toBe("");
    expect(suggestedOrgName("Зоя")).toBe("");
  });
});

describe("FIRST_PROJECT", () => {
  it("is my-api with one production environment", () => {
    expect(FIRST_PROJECT).toEqual({ name: "my-api", slug: "my-api", environments: ["production"] });
  });
});

describe("welcomeCards", () => {
  it("offers invitations first, then the organizations already joined, then domain matches", () => {
    const cards = welcomeCards(
      ctx([org("acme", "Acme")]),
      [invitation()],
      [joinable()],
    );
    expect(cards.map((c) => `${c.kind}:${c.slug}`)).toEqual(["invitation:globex", "member:acme", "domain:initech"]);
  });

  it("offers invitations first, then verified-domain matches", () => {
    expect(welcomeCards(ctx(), [invitation()], [joinable()])).toEqual([
      { kind: "invitation", id: "inv1", slug: "globex", name: "Globex", role: "member", invitedBy: "Olive Owner" },
      { kind: "domain", slug: "initech", name: "Initech", memberCount: 4, projectCount: 2, initials: ["PG", "BL"] },
    ]);
  });

  it("never offers to join an organization the user already belongs to", () => {
    const cards = welcomeCards(ctx([org("globex", "Globex")]), [invitation()], [joinable({ slug: "globex", name: "Globex" })]);
    expect(cards).toEqual([{ kind: "member", slug: "globex", name: "Globex" }]);
  });

  it("shows one card per organization when two invitations share it", () => {
    // Invitation addresses are trimmed but not lower-cased, so one organization can hold a
    // pending invitation for Bob@x.com and another for bob@x.com.
    const cards = welcomeCards(ctx(), [invitation(), invitation({ id: "inv2", role: "admin" })], []);
    expect(cards).toEqual([
      { kind: "invitation", id: "inv1", slug: "globex", name: "Globex", role: "member", invitedBy: "Olive Owner" },
    ]);
  });

  it("drops a verified-domain match an invitation already offers", () => {
    const cards = welcomeCards(ctx(), [invitation()], [joinable({ slug: "globex", name: "Globex" }), joinable()]);
    expect(cards.map((c) => `${c.kind}:${c.slug}`)).toEqual(["invitation:globex", "domain:initech"]);
  });
});
