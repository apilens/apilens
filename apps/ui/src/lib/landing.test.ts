import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_VIEW } from "./data";
import { ApiError, type ContextOrg, type UserContext } from "./identity";
import { HOME_SCREEN_VIEW, homeView, landingFor, onboardingPath, orgLanding, projectHasData, sdkSetupPath } from "./landing";

class Redirect extends Error {
  constructor(readonly location: string) {
    super(`redirect ${location}`);
  }
}

let payload: object | null = null;
const getContext = vi.fn();
const listManagedApps = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new Redirect(location);
  },
}));
vi.mock("./auth/server", () => ({
  getSession: async () => ({ payload, call: <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) }),
  getContext: (next: string) => getContext(next),
}));
vi.mock("./identity", async (orig) => ({
  ...(await orig<typeof import("./identity")>()),
  identity: () => ({ listManagedApps }),
}));

const { default: Home } = await import("@/app/page");

const ACME: ContextOrg = {
  id: "o1",
  slug: "acme",
  name: "Acme",
  role: "owner",
  projects: [
    { id: "p1", slug: "shop", name: "shop", environments: ["production"], app_count: 1, role: "admin" as const },
    { id: "p2", slug: "billing", name: "billing", environments: ["production"], app_count: 1, role: "admin" as const },
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
    expect(landingFor(ctx())).toBe(`/project/billing/${HOME_VIEW}`);
  });

  it.each([
    ["endpoints", "traffic"],
    ["requests", "explore"],
    ["exceptions", "errors"],
  ] as const)("home screen %s opens %s", (home, view) => {
    expect(HOME_SCREEN_VIEW[home]).toBe(view);
    expect(homeView(ctx({}, { home }))).toBe(view);
    expect(landingFor(ctx({}, { home }))).toBe(`/project/billing/${view}`);
    expect(landingFor(ctx({}, { home }), true)).toBe(`/project/billing/${view}`);
  });

  it("an unknown home preference opens the default view", () => {
    expect(landingFor(ctx({}, { home: "explore" as never }))).toBe(`/project/billing/${HOME_VIEW}`);
    expect(landingFor(ctx({}, { home: "dashboard" as never }))).toBe(`/project/billing/${HOME_VIEW}`);
  });

  it("a project with no ingested data opens Settings > SDK setup, whatever the home screen", () => {
    expect(sdkSetupPath("billing")).toBe("/project/billing/settings/sdk");
    expect(landingFor(ctx(), false)).toBe("/project/billing/settings/sdk");
    expect(landingFor(ctx({}, { home: "exceptions" }), false)).toBe("/project/billing/settings/sdk");
    expect(landingFor(ctx({ last_project_slug: null }), false)).toBe("/project/shop/settings/sdk");
    // The rule never overrides onboarding.
    expect(landingFor(ctx({ orgs: [], last_project_slug: null, onboarding: { step: "join", completed: false } }), false)).toBe(
      "/onboarding/join",
    );
  });

  it("falls back to the first visible project without a (visible) last project", () => {
    expect(landingFor(ctx({ last_project_slug: null }))).toBe(`/project/shop/${HOME_VIEW}`);
    expect(landingFor(ctx({ last_project_slug: "gone" }))).toBe(`/project/shop/${HOME_VIEW}`);
  });

  it("an organization without projects resumes onboarding, or opens its projects page once onboarded", () => {
    const empty = { ...ACME, projects: [] };
    expect(landingFor(ctx({ orgs: [empty], last_project_slug: null, onboarding: { step: "create", completed: false } }))).toBe(
      "/onboarding/create",
    );
    expect(landingFor(ctx({ orgs: [empty], last_project_slug: null }))).toBe("/org/acme");
  });
});

describe("orgLanding (/org)", () => {
  const BETA = { ...ACME, id: "o2", slug: "beta", name: "Beta", projects: [{ ...ACME.projects[0], id: "p3", slug: "web" }] };

  it("opens the last project's organization", () => {
    expect(orgLanding(ctx({ orgs: [ACME, BETA], last_project_slug: "web" }))).toBe("/org/beta");
    expect(orgLanding(ctx({ orgs: [ACME, BETA], last_project_slug: "billing" }))).toBe("/org/acme");
  });

  it("falls back to the first organization", () => {
    expect(orgLanding(ctx({ orgs: [BETA, ACME], last_project_slug: null }))).toBe("/org/beta");
    expect(orgLanding(ctx({ orgs: [BETA, ACME], last_project_slug: "gone" }))).toBe("/org/beta");
  });

  it("sends a user without an organization to onboarding", () => {
    expect(orgLanding(ctx({ orgs: [], last_project_slug: null, onboarding: { step: "join", completed: false } }))).toBe("/onboarding/join");
  });
});

describe("projectHasData", () => {
  const app = (first: string | null, last: string | null = null) => ({ first_seen_at: first, last_seen_at: last });

  it("is false without apps, or when no app ever reported", () => {
    expect(projectHasData(null)).toBe(false);
    expect(projectHasData([])).toBe(false);
    expect(projectHasData([app(null), app(null)])).toBe(false);
  });

  it("is true once any app has been seen", () => {
    expect(projectHasData([app(null), app("2026-11-10T00:00:00Z")])).toBe(true);
    expect(projectHasData([app(null, "2026-11-10T00:00:00Z")])).toBe(true);
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
    listManagedApps.mockReset();
    listManagedApps.mockResolvedValue({ apps: [{ first_seen_at: "2026-11-10T00:00:00Z", last_seen_at: null }] });
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
    getContext.mockResolvedValue(ctx({}, { home: "requests" }));
    await expect(Home()).rejects.toEqual(new Redirect("/project/billing/explore"));
    expect(listManagedApps).toHaveBeenCalledWith("billing", { accessToken: "a" });
  });

  it("signed in on a project with no ingested data → its SDK setup", async () => {
    getContext.mockResolvedValue(ctx({}, { home: "exceptions" }));
    listManagedApps.mockResolvedValue({ apps: [{ first_seen_at: null, last_seen_at: null }] });
    await expect(Home()).rejects.toEqual(new Redirect("/project/billing/settings/sdk"));
  });

  it("the data check failing falls back to the home view", async () => {
    getContext.mockResolvedValue(ctx({}, { home: "exceptions" }));
    listManagedApps.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    await expect(Home()).rejects.toEqual(new Redirect("/project/billing/errors"));
  });
});
