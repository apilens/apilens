import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_VIEW } from "./data";
import type { ContextOrg, UserContext } from "./identity";
import { landingFor, onboardingPath } from "./landing";

class Redirect extends Error {
  constructor(readonly location: string) {
    super(`redirect ${location}`);
  }
}

let payload: object | null = null;
const getContext = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new Redirect(location);
  },
}));
vi.mock("./auth/server", () => ({
  getSession: async () => ({ payload }),
  getContext: (next: string) => getContext(next),
}));

const { default: Home } = await import("@/app/page");

const ACME: ContextOrg = {
  id: "o1",
  slug: "acme",
  name: "Acme",
  role: "owner",
  projects: [
    { id: "p1", slug: "shop", name: "shop", environments: ["production"], app_count: 1 },
    { id: "p2", slug: "billing", name: "billing", environments: ["production"], app_count: 1 },
  ],
};

function ctx(over: Partial<UserContext> = {}, prefs: UserContext["user"]["preferences"] = {}): UserContext {
  return {
    user: {
      id: "u1",
      email: "grace@example.com",
      email_verified: true,
      name: "Grace Hopper",
      avatar_url: null,
      preferences: prefs,
      onboarding: { step: null, completed: true },
      created_at: "2026-11-01T00:00:00Z",
    },
    orgs: [ACME],
    last_project_slug: "billing",
    onboarding: { step: null, completed: true },
    capabilities: {},
    ...over,
  };
}

describe("landingFor", () => {
  it("sends a user without an organization to onboarding, resuming the stored step", () => {
    expect(landingFor(ctx({ orgs: [], last_project_slug: null, onboarding: { step: null, completed: false } }))).toBe(
      "/onboarding/about",
    );
    expect(landingFor(ctx({ orgs: [], last_project_slug: null, onboarding: { step: "join", completed: false } }))).toBe(
      "/onboarding/join",
    );
  });

  it("opens the last project on the default view", () => {
    expect(landingFor(ctx())).toBe(`/billing/${HOME_VIEW}`);
  });

  it("uses the home preference when it names a view", () => {
    expect(landingFor(ctx({}, { home: "explore" as never }))).toBe("/billing/explore");
    expect(landingFor(ctx({}, { home: "endpoints" }))).toBe(`/billing/${HOME_VIEW}`);
  });

  it("falls back to the first visible project without a (visible) last project", () => {
    expect(landingFor(ctx({ last_project_slug: null }))).toBe(`/shop/${HOME_VIEW}`);
    expect(landingFor(ctx({ last_project_slug: "gone" }))).toBe(`/shop/${HOME_VIEW}`);
  });

  it("an organization without projects resumes onboarding, or opens its settings once onboarded", () => {
    const empty = { ...ACME, projects: [] };
    expect(landingFor(ctx({ orgs: [empty], last_project_slug: null, onboarding: { step: "create", completed: false } }))).toBe(
      "/onboarding/create",
    );
    expect(landingFor(ctx({ orgs: [empty], last_project_slug: null }))).toBe("/orgs/acme/settings");
  });
});

describe("onboardingPath", () => {
  it.each(["about", "join", "create", "project"])("%s has a page", (step) => {
    expect(onboardingPath(step)).toBe(`/onboarding/${step}`);
  });

  it.each([null, undefined, "", "../evil", "instrument"])("%j falls back to the first step", (step) => {
    expect(onboardingPath(step)).toBe("/onboarding/about");
  });
});

describe("/ (app/page.tsx)", () => {
  beforeEach(() => {
    payload = { access: "a", refresh: "r", exp: 0, remember: false, uid: "u1" };
    getContext.mockReset();
  });

  it("signed out → /sign-in", async () => {
    payload = null;
    await expect(Home()).rejects.toEqual(new Redirect("/sign-in"));
    expect(getContext).not.toHaveBeenCalled();
  });

  it("signed in without an organization → onboarding at the stored step", async () => {
    getContext.mockResolvedValue(ctx({ orgs: [], last_project_slug: null, onboarding: { step: "join", completed: false } }));
    await expect(Home()).rejects.toEqual(new Redirect("/onboarding/join"));
    expect(getContext).toHaveBeenCalledWith("/");
  });

  it("signed in with projects → last project on the home view", async () => {
    getContext.mockResolvedValue(ctx({}, { home: "explore" as never }));
    await expect(Home()).rejects.toEqual(new Redirect("/billing/explore"));
  });
});
