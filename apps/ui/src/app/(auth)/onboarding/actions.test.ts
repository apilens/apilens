import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ContextOrg, type UserContext } from "@/lib/identity";

const context = vi.fn();
const updateOnboarding = vi.fn();
const updateMe = vi.fn();
const joinOrg = vi.fn();
let expired = false;

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ context, updateOnboarding, updateMe, joinOrg }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = {
    call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => {
      if (expired) throw new real.SessionExpiredError();
      return fn({ accessToken: "a" });
    },
  };
  return {
    ...real,
    // Same contract as the real one, without cookies: an expired session redirects to sign-in.
    withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => {
      try {
        return await fn(session);
      } catch (err) {
        if (real.isSessionExpired(err)) throw new Redirect(real.SESSION_EXPIRED_PATH);
        throw err;
      }
    },
  };
});

const { finishInvitedOnboarding, joinTeam, saveHome, saveOnboarding } = await import("./actions");

const saved = { step: "create", completed: false, completed_at: null, answers: { org_slug: "example-co" } };

const GLOBEX: ContextOrg = {
  id: "o2",
  slug: "globex",
  name: "Globex",
  role: "member",
  projects: [{ id: "p2", slug: "storefront", name: "storefront", environments: ["production"], app_count: 1, role: "admin" as const }],
};

function ctx(answers: Record<string, unknown>, orgs: ContextOrg[]): UserContext {
  const onboarding = { step: "about", completed: false, answers };
  return {
    user: { id: "u1", email: "grace@example.com", email_verified: true, name: null, avatar_url: null, preferences: {}, onboarding, created_at: "2026-11-01T00:00:00Z" },
    orgs,
    last_project_slug: null,
    onboarding: { step: "about", completed: false },
    capabilities: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
});

describe("saveOnboarding", () => {
  it("saves the step and answers as the signed-in user", async () => {
    updateOnboarding.mockResolvedValue(saved);
    await expect(saveOnboarding("create", { org_slug: "example-co" })).resolves.toEqual({ ok: true, onboarding: saved });
    expect(updateOnboarding).toHaveBeenCalledWith({ step: "create", answers: { org_slug: "example-co" } }, { accessToken: "a" });
  });

  it("leaves the step alone when none is given", async () => {
    updateOnboarding.mockResolvedValue(saved);
    await saveOnboarding(undefined, { language: "python" });
    expect(updateOnboarding).toHaveBeenCalledWith({ answers: { language: "python" } }, { accessToken: "a" });
  });

  it("refuses input outside the schema without calling the API", async () => {
    for (const [step, answers] of [
      ["Create", {}],
      ["create", { org_slug: "Not A Slug" }],
      ["create", { home: "requests" }],
      ["invite", { invited: -2 }],
    ] as const) {
      await expect(saveOnboarding(step, answers as never)).resolves.toEqual({
        ok: false,
        error: "Some answers weren’t accepted. Check them and try again.",
        code: "invalid_request",
      });
    }
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("answers a sentence when the API refuses", async () => {
    updateOnboarding.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    await expect(saveOnboarding("join")).resolves.toEqual({
      ok: false,
      error: "We couldn’t reach APILens to save your progress. Check your connection and try again.",
      code: "unavailable",
    });
  });

  it("an expired session goes to sign-in", async () => {
    expired = true;
    await expect(saveOnboarding("join")).rejects.toEqual(new Redirect("/sign-in?reason=session_expired"));
  });

  it("does not swallow unexpected errors", async () => {
    updateOnboarding.mockRejectedValue(new TypeError("boom"));
    await expect(saveOnboarding("join")).rejects.toThrow("boom");
  });
});

describe("finishInvitedOnboarding", () => {
  it("finishes onboarding and opens the invited organization's first project", async () => {
    context.mockResolvedValue(ctx({ org_slug: "globex" }, [GLOBEX]));
    updateOnboarding.mockResolvedValue({});
    await expect(finishInvitedOnboarding()).rejects.toEqual(new Redirect("/storefront/incidents"));
    expect(updateOnboarding).toHaveBeenCalledWith({ completed: true }, { accessToken: "a" });
  });

  it("someone who was not invited continues to the organization step", async () => {
    context.mockResolvedValue(ctx({}, []));
    await expect(finishInvitedOnboarding()).rejects.toEqual(new Redirect("/onboarding/join"));
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("an expired session signs in again", async () => {
    expired = true;
    await expect(finishInvitedOnboarding()).rejects.toEqual(new Redirect("/sign-in?reason=session_expired"));
  });
});

describe("saveHome", () => {
  const user = { id: "u1", email: "grace@example.com", preferences: { home: "exceptions", last_project_slug: "shop" } };

  it("saves the pick as the home preference as the signed-in user", async () => {
    updateMe.mockResolvedValue(user);
    await expect(saveHome("exceptions")).resolves.toEqual({ ok: true, home: "exceptions" });
    expect(updateMe).toHaveBeenCalledWith({ preferences: { home: "exceptions" } }, { accessToken: "a" });
  });

  it("refuses a home screen the API does not offer without calling it", async () => {
    for (const home of ["dashboard", "", null, 3, { home: "requests" }]) {
      await expect(saveHome(home as never)).resolves.toEqual({
        ok: false,
        error: "Some answers weren’t accepted. Check them and try again.",
        code: "invalid_request",
      });
    }
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("answers a sentence when the API refuses", async () => {
    updateMe.mockRejectedValue(new ApiError({ status: 429, code: "rate_limited" }));
    await expect(saveHome("requests")).resolves.toEqual({
      ok: false,
      error: "Too many attempts in a row. Wait a moment and try again.",
      code: "rate_limited",
    });
  });

  it("an expired session goes to sign-in", async () => {
    expired = true;
    await expect(saveHome("requests")).rejects.toEqual(new Redirect("/sign-in?reason=session_expired"));
  });

  it("does not swallow unexpected errors", async () => {
    updateMe.mockRejectedValue(new TypeError("boom"));
    await expect(saveHome("requests")).rejects.toThrow("boom");
  });
});

describe("joinTeam", () => {
  const joined = { id: "o2", slug: "globex", name: "Globex", role: "member" };

  it("joins, finishes onboarding and opens the organization's first project", async () => {
    joinOrg.mockResolvedValue(joined);
    context.mockResolvedValue(ctx({}, [GLOBEX]));
    updateOnboarding.mockResolvedValue({});
    await expect(joinTeam("globex", "Globex")).rejects.toEqual(new Redirect("/storefront/incidents"));
    expect(joinOrg).toHaveBeenCalledWith("globex", { accessToken: "a" });
    expect(updateOnboarding).toHaveBeenCalledWith({ completed: true, answers: { org_slug: "globex" } }, { accessToken: "a" });
  });

  it("an organization without projects continues to the project step", async () => {
    joinOrg.mockResolvedValue(joined);
    context.mockResolvedValue(ctx({}, [{ ...GLOBEX, projects: [] }]));
    updateOnboarding.mockResolvedValue({});
    await expect(joinTeam("globex", "Globex")).rejects.toEqual(new Redirect("/onboarding/project"));
    expect(updateOnboarding).toHaveBeenCalledWith({ step: "project", answers: { org_slug: "globex" } }, { accessToken: "a" });
  });

  it("answers a sentence when the organization is no longer joinable", async () => {
    joinOrg.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    await expect(joinTeam("globex", "Globex")).resolves.toEqual({
      ok: false,
      error: "You can no longer join Globex. Its owners may have turned off joining by email domain.",
      code: "forbidden",
    });
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("refuses a malformed slug without calling the API", async () => {
    await expect(joinTeam("Not A Slug", "X")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(joinOrg).not.toHaveBeenCalled();
  });

  it("an expired session signs in again", async () => {
    expired = true;
    await expect(joinTeam("globex", "Globex")).rejects.toEqual(new Redirect("/sign-in?reason=session_expired"));
  });
});
