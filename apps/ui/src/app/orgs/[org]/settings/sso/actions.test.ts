import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const putOrgSSO = vi.fn();
const deleteOrgSSO = vi.fn();
const testOrgSSO = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ putOrgSSO, deleteOrgSSO, testOrgSSO }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { deleteSSOConnection, saveSSOConnection, testSSOConnection } = await import("./actions");

const form = {
  issuer: "https://idp.example.com",
  clientId: "client",
  clientSecret: "",
  domains: ["example.com"],
  defaultRole: "member",
  enforce: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveSSOConnection", () => {
  it("puts the checked body, keeping the stored secret, and refreshes the page", async () => {
    putOrgSSO.mockResolvedValue({ issuer: form.issuer });
    const res = await saveSSOConnection("acme", form, true);
    expect(res).toEqual({ ok: true, connection: { issuer: form.issuer } });
    expect(putOrgSSO).toHaveBeenCalledWith(
      "acme",
      { issuer: form.issuer, client_id: "client", domains: ["example.com"], enforce: true, default_role: "member" },
      { accessToken: "a" },
    );
    expect(revalidatePath).toHaveBeenCalledWith("/orgs/acme/settings/sso");
  });

  it("refuses a new connection without a secret before calling the API", async () => {
    const res = await saveSSOConnection("acme", form, false);
    expect(res).toMatchObject({ ok: false, error: /client secret/ });
    expect(putOrgSSO).not.toHaveBeenCalled();
  });

  it("refuses a bad slug or body", async () => {
    expect((await saveSSOConnection("../x", form, true)).ok).toBe(false);
    expect((await saveSSOConnection("acme", null as never, true)).ok).toBe(false);
    expect(putOrgSSO).not.toHaveBeenCalled();
  });

  it("explains sso_untested", async () => {
    putOrgSSO.mockRejectedValue(new ApiError({ status: 409, code: "sso_untested" }));
    const res = await saveSSOConnection("acme", form, true);
    expect(res).toMatchObject({ ok: false, code: "sso_untested", error: /Sign in through this connection/ });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteSSOConnection", () => {
  it("deletes and refreshes", async () => {
    deleteOrgSSO.mockResolvedValue(undefined);
    expect(await deleteSSOConnection("acme")).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/orgs/acme/settings/sso");
  });

  it("answers a sentence for forbidden", async () => {
    deleteOrgSSO.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    expect(await deleteSSOConnection("acme")).toMatchObject({ ok: false, error: /Only owners/ });
  });
});

describe("testSSOConnection", () => {
  it("tests the typed issuer", async () => {
    testOrgSSO.mockResolvedValue({ ok: true, issuer: "https://idp.example.com" });
    const res = await testSSOConnection("acme", " https://idp.example.com ");
    expect(res).toEqual({ ok: true, result: { ok: true, issuer: "https://idp.example.com" } });
    expect(testOrgSSO).toHaveBeenCalledWith("acme", "https://idp.example.com", { accessToken: "a" });
  });

  it("falls back to the saved issuer when none is typed", async () => {
    testOrgSSO.mockResolvedValue({ ok: false, issuer: "https://idp.example.com", error: "unreachable" });
    await testSSOConnection("acme", "");
    expect(testOrgSSO).toHaveBeenCalledWith("acme", undefined, { accessToken: "a" });
  });

  it("refuses an issuer the API would refuse", async () => {
    const res = await testSSOConnection("acme", "http://idp.example.com");
    expect(res).toMatchObject({ ok: false, code: "invalid_request" });
    expect(testOrgSSO).not.toHaveBeenCalled();
  });
});
