import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextOrg, OnboardingState, UserContext } from "./identity";
import { onboardingDecision } from "./onboarding";

class Redirect extends Error {
  constructor(readonly location: string) {
    super(`redirect ${location}`);
  }
}

let payload: object | null = null;
const getContext = vi.fn();

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

const { requireOnboardingStep } = await import("./auth/onboarding");

const ACME: ContextOrg = {
  id: "o1",
  slug: "acme",
  name: "Acme",
  role: "owner",
  projects: [{ id: "p1", slug: "shop", name: "shop", environments: ["production"], app_count: 1, role: "admin" as const }],
};

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

describe("onboardingDecision", () => {
  it("sends a user who has finished onboarding to their landing page", () => {
    expect(onboardingDecision(ctx({ completed: true, step: "done" }, [ACME]))).toEqual({ kind: "redirect", location: "/project/shop/traffic" });
  });
  it("shows Welcome to anyone who has not", () => {
    expect(onboardingDecision(ctx({ completed: false, step: "welcome" }))).toEqual({ kind: "show" });
  });
  it("shows Welcome to a finished user with nothing to open", () => {
    expect(onboardingDecision(ctx({ completed: true, step: "done" }, []))).toEqual({ kind: "show" });
  });
});

describe("requireOnboardingStep", () => {
  beforeEach(() => {
    payload = { access: "a", refresh: "r", exp: 0, remember: false, uid: "u1" };
    getContext.mockReset();
  });

  it("signed out → sign-up, then onboarding", async () => {
    payload = null;
    await expect(requireOnboardingStep("welcome")).rejects.toEqual(
      new Redirect(`/sign-up?next=${encodeURIComponent("/onboarding/welcome")}`),
    );
    expect(getContext).not.toHaveBeenCalled();
  });

  it("loads the context for the page's own path and lets an unfinished user through", async () => {
    getContext.mockResolvedValue(ctx({ step: "welcome", completed: false }));
    await expect(requireOnboardingStep("welcome")).resolves.toBeUndefined();
    expect(getContext).toHaveBeenCalledWith("/onboarding/welcome");
  });

  it("finished → the project", async () => {
    getContext.mockResolvedValue(ctx({ step: "done", completed: true }, [ACME]));
    await expect(requireOnboardingStep("welcome")).rejects.toEqual(new Redirect("/project/shop/traffic"));
  });
});
