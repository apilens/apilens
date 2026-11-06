import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextOrg, OnboardingState, UserContext } from "./identity";
import { alreadyReached, onboardingDecision, stageOf, stepToSave } from "./onboarding";

class Redirect extends Error {
  constructor(readonly location: string) {
    super(`redirect ${location}`);
  }
}

let payload: object | null = null;
const getContext = vi.fn();
const listJoinableOrgs = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new Redirect(location);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Redirect) throw err;
  },
}));
vi.mock("./env", () => ({ env: () => ({ publicUrl: "https://app.apilens.test" }) }));
vi.mock("./auth/server", () => ({
  getSession: async () => ({ payload, call: <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) }),
  getContext: (next: string) => getContext(next),
}));
vi.mock("./identity", async (orig) => ({
  ...(await orig<typeof import("./identity")>()),
  identity: () => ({ listJoinableOrgs }),
}));

const { requireOnboardingStep } = await import("./auth/onboarding");
const { default: AboutPage } = await import("@/app/(auth)/onboarding/about/page");
const { default: JoinPage } = await import("@/app/(auth)/onboarding/join/page");
const { default: CreatePage } = await import("@/app/(auth)/onboarding/create/page");

const ACME: ContextOrg = {
  id: "o1",
  slug: "acme",
  name: "Acme",
  role: "owner",
  projects: [{ id: "p1", slug: "shop", name: "shop", environments: ["production"], app_count: 1 }],
};

const INITECH = { id: "o3", slug: "initech", name: "Initech", member_count: 3, project_count: 0, member_initials: ["PG"] };

function ctx(onboarding: OnboardingState, orgs: ContextOrg[] = []): UserContext {
  return {
    user: {
      id: "u1",
      email: "grace@example.com",
      email_verified: true,
      name: "Grace Hopper",
      avatar_url: null,
      preferences: {},
      onboarding,
      created_at: "2026-11-01T00:00:00Z",
    },
    orgs,
    last_project_slug: orgs.length ? "shop" : null,
    onboarding,
    capabilities: {},
  };
}

describe("stageOf", () => {
  it("maps stored steps to the step bar", () => {
    expect(stageOf("about")).toBe(0);
    expect(stageOf("join")).toBe(1);
    expect(stageOf("create")).toBe(1);
    expect(stageOf("project")).toBe(2);
    expect(stageOf("install")).toBe(3);
    expect(stageOf("waiting")).toBe(4);
    expect(stageOf("first-data")).toBe(4);
  });

  it.each([null, undefined, "", "toString", "../evil"])("%j counts as the first step", (step) => {
    expect(stageOf(step)).toBe(0);
  });
});

describe("onboardingDecision", () => {
  it("shows the saved step", () => {
    expect(onboardingDecision(ctx({ step: "join", completed: false }), "join")).toEqual({ kind: "show", step: 1, reached: 1 });
  });

  it("a new user (no saved step) starts at about", () => {
    expect(onboardingDecision(ctx({ step: null, completed: false }), "about")).toEqual({ kind: "show", step: 0, reached: 0 });
    expect(onboardingDecision(ctx({ step: null, completed: false }), "create")).toEqual({
      kind: "redirect",
      location: "/onboarding/about",
    });
  });

  it("a step ahead of the saved one goes back to the saved step", () => {
    expect(onboardingDecision(ctx({ step: "about", completed: false }), "join")).toEqual({
      kind: "redirect",
      location: "/onboarding/about",
    });
  });

  it("earlier steps stay reachable (back navigation) and show the saved progress", () => {
    expect(onboardingDecision(ctx({ step: "create", completed: false }), "about")).toEqual({ kind: "show", step: 0, reached: 1 });
    expect(onboardingDecision(ctx({ step: "project", completed: false }, [ACME]), "create")).toEqual({
      kind: "show",
      step: 1,
      reached: 2,
    });
  });

  it("join and create are alternatives on the same step", () => {
    expect(onboardingDecision(ctx({ step: "join", completed: false }), "create")).toEqual({ kind: "show", step: 1, reached: 1 });
    expect(onboardingDecision(ctx({ step: "create", completed: false }), "join")).toEqual({ kind: "show", step: 1, reached: 1 });
  });

  it("a finished user goes to their project", () => {
    expect(onboardingDecision(ctx({ step: "invite", completed: true }, [ACME]), "about")).toEqual({
      kind: "redirect",
      location: "/shop/incidents",
    });
  });

  it("a finished user with nothing to open may onboard again", () => {
    expect(onboardingDecision(ctx({ step: null, completed: true }), "about")).toEqual({ kind: "show", step: 0, reached: 0 });
  });
});

describe("requireOnboardingStep", () => {
  beforeEach(() => {
    payload = { access: "a", refresh: "r", exp: 0, remember: false, uid: "u1" };
    getContext.mockReset();
  });

  it("signed out → sign-up, then the first step", async () => {
    payload = null;
    await expect(requireOnboardingStep("join")).rejects.toEqual(
      new Redirect(`/sign-up?next=${encodeURIComponent("/onboarding/about")}`),
    );
    expect(getContext).not.toHaveBeenCalled();
  });

  it("loads the context for the page's own path and returns the step bar state", async () => {
    getContext.mockResolvedValue(ctx({ step: "create", completed: false }));
    await expect(requireOnboardingStep("about")).resolves.toEqual({ kind: "show", step: 0, reached: 1, answers: {}, home: "endpoints" });
    expect(getContext).toHaveBeenCalledWith("/onboarding/about");
  });

  it("hands the page the saved answers (#327)", async () => {
    getContext.mockResolvedValue(ctx({ step: "create", completed: false, answers: { org_slug: "example-co", invited: 2 } }));
    await expect(requireOnboardingStep("create")).resolves.toEqual({
      kind: "show",
      step: 1,
      reached: 1,
      answers: { org_slug: "example-co", invited: 2 },
      home: "endpoints",
    });
  });

  it("hands the page the saved home screen (#328)", async () => {
    const saved = ctx({ step: "join", completed: false });
    saved.user.preferences = { home: "exceptions" };
    getContext.mockResolvedValue(saved);
    await expect(requireOnboardingStep("about")).resolves.toMatchObject({ step: 0, reached: 1, home: "exceptions" });
  });

  it("finished → the project", async () => {
    getContext.mockResolvedValue(ctx({ step: null, completed: true }, [ACME]));
    await expect(requireOnboardingStep("about")).rejects.toEqual(new Redirect("/shop/incidents"));
  });

  it("ahead of the saved step → the saved step", async () => {
    getContext.mockResolvedValue(ctx({ step: "about", completed: false }));
    await expect(requireOnboardingStep("create")).rejects.toEqual(new Redirect("/onboarding/about"));
  });
});

describe("/onboarding/* pages", () => {
  beforeEach(() => {
    payload = { access: "a", refresh: "r", exp: 0, remember: false, uid: "u1" };
    getContext.mockReset().mockResolvedValue(ctx({ step: "join", completed: false, answers: { org_slug: "example-co" } }));
    listJoinableOrgs.mockReset().mockResolvedValue([INITECH]);
  });

  it("render with the real step bar state", async () => {
    const about = (await AboutPage()) as { props: Record<string, unknown> };
    // The home screen pick starts from the saved preference (#328).
    expect(about.props).toEqual({ step: 0, reached: 1, home: "endpoints" });
    const join = (await JoinPage()) as { props: Record<string, unknown> };
    // The organizations to join, and the verified domain they matched (#329).
    expect(join.props).toEqual({ step: 1, reached: 1, orgs: [INITECH], domain: "example.com" });
    const create = (await CreatePage()) as { props: Record<string, unknown> };
    // The organization screen starts from the saved address (#327), shows it under the public
    // host and knows which addresses are the user's own (#330).
    expect(create.props).toEqual({ step: 1, reached: 1, answers: { org_slug: "example-co" }, host: "app.apilens.test", owned: [], back: "/onboarding/join" });
    // About and create read the context twice (guard, then their own use); `cache()` makes it one call.
    // Join reads it again for the email domain.
    expect(getContext.mock.calls.map(([p]) => p)).toEqual([
      "/onboarding/about",
      "/onboarding/about",
      "/onboarding/join",
      "/onboarding/join",
      "/onboarding/create",
      "/onboarding/create",
    ]);
  });

  it("join is skipped without organizations to join, and create's Back passes it (#329)", async () => {
    listJoinableOrgs.mockResolvedValue(null);
    await expect(JoinPage()).rejects.toEqual(new Redirect("/onboarding/create"));
    const create = (await CreatePage()) as { props: Record<string, unknown> };
    expect(create.props).toMatchObject({ back: "/onboarding/about" });
  });

  it("create's Back stays on join when the list cannot be read", async () => {
    listJoinableOrgs.mockRejectedValue(new Error("down"));
    const create = (await CreatePage()) as { props: Record<string, unknown> };
    expect(create.props).toMatchObject({ back: "/onboarding/join" });
  });

  it("about tells an invited user which organization Continue opens (#337)", async () => {
    const globex: ContextOrg = { ...ACME, id: "o2", slug: "globex", name: "Globex", role: "member" };
    const invited = ctx({ step: "about", completed: false, answers: { org_slug: "globex" } }, [globex]);
    getContext.mockResolvedValue(invited);
    const about = (await AboutPage()) as { props: Record<string, unknown> };
    expect(about.props).toEqual({ step: 0, reached: 0, home: "endpoints", invitedOrg: "Globex" });
  });

  it("redirect when the page is not allowed", async () => {
    getContext.mockResolvedValue(ctx({ step: "invite", completed: true }, [ACME]));
    await expect(JoinPage()).rejects.toEqual(new Redirect("/shop/incidents"));
  });
});

describe("stepToSave", () => {
  it("saves the step Continue moves to", () => {
    expect(stepToSave("join", 0)).toBe("join");
    expect(stepToSave("create", 1)).toBe("create");
    expect(stepToSave("project", 1)).toBe("project");
  });

  it("does not move saved progress back when an earlier screen is passed again", () => {
    expect(stepToSave("join", 2)).toBeUndefined();
    expect(stepToSave("about", 1)).toBeUndefined();
  });
});

describe("alreadyReached", () => {
  it("is true for steps the guard already lets the user onto", () => {
    expect(alreadyReached("join", 1)).toBe(true);
    expect(alreadyReached("create", 2)).toBe(true);
    expect(alreadyReached("about", 0)).toBe(true);
  });

  it("is false for a step ahead of the saved one", () => {
    expect(alreadyReached("join", 0)).toBe(false);
    expect(alreadyReached("project", 1)).toBe(false);
  });
});
