import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const createInvitations = vi.fn();
const updateOnboarding = vi.fn();
const context = vi.fn();

vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createInvitations, updateOnboarding, context }),
}));
vi.mock("@/lib/server-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/server-session")>()),
  withActionSession: async <T,>(fn: (s: { call: <R>(f: (o: { accessToken: string }) => Promise<R>) => Promise<R> }) => Promise<T>) =>
    fn({ call: (f) => f({ accessToken: "a" }) }),
}));

const { inviteTeam } = await import("./actions");

const ctx = (invited?: number) => ({ user: { onboarding: { step: "invite", completed: false, answers: invited === undefined ? {} : { invited } } }, orgs: [] });

describe("inviteTeam", () => {
  beforeEach(() => {
    createInvitations.mockReset();
    updateOnboarding.mockReset();
    context.mockReset();
  });

  it("posts each address with its role and adds the number sent to the saved answer", async () => {
    createInvitations.mockResolvedValue({
      results: [
        { email: "ada@example.com", status: "invited" },
        { email: "you@example.com", status: "already_member" },
        { email: "grace@example.com", status: "replaced" },
      ],
    });
    context.mockResolvedValue(ctx(1));
    updateOnboarding.mockResolvedValue({});
    const res = await inviteTeam("example-co", [
      { email: "Ada@Example.com", role: "member" },
      { email: "you@example.com", role: "viewer" },
      { email: "grace@example.com", role: "admin" },
    ]);
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.results.map((r) => r.status)).toEqual(["invited", "already_member", "replaced"]);
    expect(createInvitations.mock.calls[0][0]).toBe("example-co");
    expect(createInvitations.mock.calls[0][1]).toEqual([
      { email: "ada@example.com", role: "member" },
      { email: "you@example.com", role: "viewer" },
      { email: "grace@example.com", role: "admin" },
    ]);
    expect(updateOnboarding.mock.calls[0][0]).toEqual({ answers: { invited: 3 } });
  });

  it("does not save a count when nothing was sent", async () => {
    createInvitations.mockResolvedValue({ results: [{ email: "you@example.com", status: "already_member" }] });
    expect(await inviteTeam("example-co", [{ email: "you@example.com", role: "member" }])).toMatchObject({ ok: true });
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("still answers the results when saving the count fails", async () => {
    createInvitations.mockResolvedValue({ results: [{ email: "ada@example.com", status: "invited" }] });
    context.mockResolvedValue(ctx());
    updateOnboarding.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    expect(await inviteTeam("example-co", [{ email: "ada@example.com", role: "member" }])).toMatchObject({ ok: true });
  });

  it.each([
    ["a bad slug", "../admin", [{ email: "ada@example.com", role: "member" }]],
    ["no addresses", "example-co", []],
    ["an invalid address", "example-co", [{ email: "not-an-email", role: "member" }]],
    ["the owner role", "example-co", [{ email: "ada@example.com", role: "owner" }]],
    ["more than 50 addresses", "example-co", Array.from({ length: 51 }, (_, i) => ({ email: `p${i}@example.com`, role: "member" }))],
  ])("refuses %s without calling the API", async (_name, org, entries) => {
    expect(await inviteTeam(org as string, entries as never)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(createInvitations).not.toHaveBeenCalled();
  });

  it("answers a sentence for an API error", async () => {
    createInvitations.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    expect(await inviteTeam("example-co", [{ email: "ada@example.com", role: "member" }])).toMatchObject({
      ok: false,
      code: "forbidden",
      error: expect.stringContaining("owners and admins"),
    });
  });
});
