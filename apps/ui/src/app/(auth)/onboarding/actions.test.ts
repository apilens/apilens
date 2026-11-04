import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const updateOnboarding = vi.fn();
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
  identity: () => ({ updateOnboarding }),
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

const { saveOnboarding } = await import("./actions");

const saved = { step: "create", completed: false, completed_at: null, answers: { org_slug: "example-co" } };

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
