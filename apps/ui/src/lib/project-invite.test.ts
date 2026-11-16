import { describe, expect, it } from "vitest";
import { grantOn, inviteResultProblem, inviteSuggestions, isProjectInviteOrgRole, projectInviteError, projectInvitedMessage } from "./project-invite";

describe("inviteSuggestions", () => {
  const known = [{ email: "max@example.com" }, { email: "Vera@Example.com" }];

  it("offers typed addresses that match no organization member, lower-cased and once each", () => {
    expect(inviteSuggestions("New.Dev@Example.com", known)).toEqual(["new.dev@example.com"]);
    expect(inviteSuggestions("a@example.com, b@example.com a@example.com", known)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("offers nothing for names, partial addresses or members", () => {
    expect(inviteSuggestions("max", known)).toEqual([]);
    expect(inviteSuggestions("new@", known)).toEqual([]);
    expect(inviteSuggestions("max@example.com vera@example.com", known)).toEqual([]);
    expect(inviteSuggestions("   ", known)).toEqual([]);
  });
});

describe("isProjectInviteOrgRole", () => {
  it("allows member and viewer only", () => {
    expect(isProjectInviteOrgRole("member")).toBe(true);
    expect(isProjectInviteOrgRole("viewer")).toBe(true);
    expect(isProjectInviteOrgRole("admin")).toBe(false);
    expect(isProjectInviteOrgRole("owner")).toBe(false);
    expect(isProjectInviteOrgRole(1)).toBe(false);
  });
});

describe("inviteResultProblem", () => {
  it("explains refused addresses and passes invited ones", () => {
    expect(inviteResultProblem("already_member", "Acme")).toBe("already in Acme, add them from the list");
    expect(inviteResultProblem("duplicate", "Acme")).toBe("listed twice");
    expect(inviteResultProblem("invited", "Acme")).toBeNull();
    expect(inviteResultProblem("replaced", "Acme")).toBeNull();
  });
});

describe("projectInvitedMessage", () => {
  it("says who was invited and the project role they get", () => {
    expect(projectInvitedMessage(["ada@example.com"], "Acme", "Shop", "viewer")).toBe("Invited ada@example.com to Acme. They become a Viewer on Shop once they accept.");
    expect(projectInvitedMessage(["a@example.com", "b@example.com"], "Acme", "Shop", "editor")).toBe(
      "Invited a@example.com and b@example.com to Acme. Each becomes an Editor on Shop once they accept.",
    );
  });
});

describe("projectInviteError", () => {
  it("never shows a raw code", () => {
    expect(projectInviteError("forbidden")).toBe("Only people who can invite to the organization and manage this project’s access can invite here.");
    expect(projectInviteError("invalid_request")).toBe("Some values weren’t accepted. Check them and try again.");
    expect(projectInviteError("weird")).toBe("Something went wrong. Try again in a moment.");
    expect(projectInviteError(undefined)).toBe("Something went wrong. Try again in a moment.");
  });
});

describe("grantOn", () => {
  it("reads the role an invitation carries on the project", () => {
    const inv = { project_grants: [{ project_id: "p", project: "shop", project_name: "Shop", role: "editor" as const }] };
    expect(grantOn(inv, "shop")).toBe("editor");
    expect(grantOn(inv, "other")).toBeNull();
    expect(grantOn({ project_grants: null }, "shop")).toBeNull();
  });
});
