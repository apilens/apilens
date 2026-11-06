import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type UserContext } from "../identity";
import { SessionExpiredError } from "../server-session";

const context = vi.fn();
const call = vi.fn();
let payload: object | null = { access: "a", refresh: "r", exp: 0, remember: false, uid: "u1" };

class Redirect extends Error {
  constructor(readonly next: string) {
    super(`redirect ${next}`);
  }
}

vi.mock("../identity", async (orig) => ({
  ...(await orig<typeof import("../identity")>()),
  identity: () => ({ context }),
}));
vi.mock("../server-session", async (orig) => ({
  ...(await orig<typeof import("../server-session")>()),
  componentSession: async () => ({ payload, call }),
  redirectToRefresh: (next: string) => {
    throw new Redirect(next);
  },
}));

const { getContext } = await import("./server");

const CTX: UserContext = {
  user: {
    id: "u1",
    email: "grace@example.com",
    email_verified: true,
    name: "Grace Hopper",
    avatar_url: null,
    preferences: {},
    onboarding: { step: null, completed: true },
    created_at: "2026-11-01T00:00:00Z",
  },
  orgs: [{ id: "o1", slug: "acme", name: "Acme", role: "owner", projects: [{ id: "p1", slug: "shop", name: "shop", environments: ["production"], app_count: 1 }] }],
  last_project_slug: "shop",
  onboarding: { step: null, completed: true },
  capabilities: {},
};

beforeEach(() => {
  payload = { access: "a", refresh: "r", exp: 0, remember: false, uid: "u1" };
  context.mockReset().mockResolvedValue(CTX);
  call.mockReset().mockImplementation((fn: (o: { accessToken: string }) => unknown) => fn({ accessToken: "a" }));
});

describe("getContext", () => {
  it("loads GET /users/me/context through the session", async () => {
    await expect(getContext("/shop/incidents")).resolves.toEqual(CTX);
    expect(context).toHaveBeenCalledWith({ accessToken: "a" });
  });

  it("sends a signed-out request through the refresh route back to the page", async () => {
    payload = null;
    await expect(getContext("/shop/incidents")).rejects.toEqual(new Redirect("/shop/incidents"));
    expect(context).not.toHaveBeenCalled();
  });

  it("sends an expired session through the refresh route", async () => {
    call.mockRejectedValue(new SessionExpiredError());
    await expect(getContext("/orgs/acme/settings")).rejects.toEqual(new Redirect("/orgs/acme/settings"));
  });

  it("surfaces other backend failures", async () => {
    const err = new ApiError({ status: 503, code: "unavailable", message: "down" });
    call.mockRejectedValue(err);
    await expect(getContext("/shop/incidents")).rejects.toBe(err);
  });
});
