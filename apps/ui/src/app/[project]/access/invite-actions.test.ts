import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const createInvitations = vi.fn();
const resendInvitation = vi.fn();
const revokeInvitation = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createInvitations, resendInvitation, revokeInvitation }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const actions = await import("./invite-actions");

const ID = "d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a";
const names = { org: "Acme", project: "Shop" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inviteToProject", () => {
  it("invites with the project role and revalidates the page", async () => {
    createInvitations.mockResolvedValue({ results: [{ email: "new@example.com", status: "invited" }] });
    await expect(actions.inviteToProject("shop", "acme", [{ email: "New@Example.com", role: "member" }], "editor", names)).resolves.toEqual({
      ok: true,
      message: "Invited new@example.com to Acme. They become an Editor on Shop once they accept.",
    });
    expect(createInvitations).toHaveBeenCalledWith("acme", [{ email: "new@example.com", role: "member" }], { accessToken: "a" }, [{ project: "shop", role: "editor" }]);
    expect(revalidatePath).toHaveBeenCalledWith("/shop/access");
  });

  it("returns the refused addresses with their reason next to the invited ones", async () => {
    createInvitations.mockResolvedValue({
      results: [
        { email: "new@example.com", status: "invited" },
        { email: "max@example.com", status: "already_member" },
      ],
    });
    const entries = [
      { email: "new@example.com", role: "viewer" as const },
      { email: "max@example.com", role: "viewer" as const },
    ];
    await expect(actions.inviteToProject("shop", "acme", entries, "viewer", names)).resolves.toEqual({
      ok: true,
      message: "Invited new@example.com to Acme. They become a Viewer on Shop once they accept.",
      problems: { "max@example.com": "already in Acme, add them from the list" },
    });
  });

  it("is not ok when nobody was invited", async () => {
    createInvitations.mockResolvedValue({ results: [{ email: "max@example.com", status: "already_member" }] });
    await expect(actions.inviteToProject("shop", "acme", [{ email: "max@example.com", role: "member" }], "viewer", names)).resolves.toEqual({
      ok: false,
      error: "Nobody was invited. Each address says why.",
      problems: { "max@example.com": "already in Acme, add them from the list" },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps an API refusal to a sentence", async () => {
    createInvitations.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    await expect(actions.inviteToProject("shop", "acme", [{ email: "new@example.com", role: "member" }], "viewer", names)).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
      error: "Only people who can invite to the organization and manage this project’s access can invite here.",
    });
  });

  it("refuses bad slugs, roles, addresses, duplicates and empty lists without calling the API", async () => {
    const one = [{ email: "new@example.com", role: "member" as const }];
    for (const r of [
      actions.inviteToProject("Shop!", "acme", one, "viewer", names),
      actions.inviteToProject("shop", "Acme Co", one, "viewer", names),
      actions.inviteToProject("shop", "acme", one, "owner" as never, names),
      actions.inviteToProject("shop", "acme", [{ email: "new@example.com", role: "admin" }], "viewer", names),
      actions.inviteToProject("shop", "acme", [{ email: "not-an-address", role: "member" }], "viewer", names),
      actions.inviteToProject("shop", "acme", [...one, { email: "NEW@example.com", role: "viewer" }], "viewer", names),
      actions.inviteToProject("shop", "acme", [], "viewer", names),
    ]) {
      await expect(r).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(createInvitations).not.toHaveBeenCalled();
  });
});

describe("resend and revoke", () => {
  it("resends through the organization and revalidates the project page", async () => {
    resendInvitation.mockResolvedValue({});
    await expect(actions.resendProjectInvitation("shop", "acme", ID, "new@example.com")).resolves.toEqual({ ok: true, message: "Invitation resent to new@example.com." });
    expect(resendInvitation).toHaveBeenCalledWith("acme", ID, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/shop/access");
  });

  it("passes the resend wait on", async () => {
    resendInvitation.mockRejectedValue(new ApiError({ status: 429, code: "rate_limited", retryAfter: 120 }));
    await expect(actions.resendProjectInvitation("shop", "acme", ID, "new@example.com")).resolves.toMatchObject({ ok: false, code: "rate_limited", retryAfter: 120 });
  });

  it("revokes, and refreshes the list when it was already gone", async () => {
    revokeInvitation.mockResolvedValue(undefined);
    await expect(actions.revokeProjectInvitation("shop", "acme", ID, "new@example.com")).resolves.toEqual({ ok: true, message: "Invitation to new@example.com revoked." });
    revokeInvitation.mockRejectedValue(new ApiError({ status: 410, code: "invite_expired" }));
    await expect(actions.revokeProjectInvitation("shop", "acme", ID, "new@example.com")).resolves.toMatchObject({ ok: false, code: "invite_expired" });
    expect(revalidatePath).toHaveBeenCalledTimes(2);
  });

  it("refuses a bad id or slug without calling the API", async () => {
    await expect(actions.resendProjectInvitation("shop", "acme", "nope", "x")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(actions.revokeProjectInvitation("shop", "Acme!", ID, "x")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(resendInvitation).not.toHaveBeenCalled();
    expect(revokeInvitation).not.toHaveBeenCalled();
  });
});
