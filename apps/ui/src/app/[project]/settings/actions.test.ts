import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const createApiKey = vi.fn();
const revokeApiKey = vi.fn();
const listApiKeys = vi.fn();
let expired = false;

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createApiKey, revokeApiKey, listApiKeys }),
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

const actions = await import("./actions");

const ID = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const listed = {
  id: ID,
  name: "Production",
  prefix: "apl_live_abcdefg",
  scopes: ["ingest"],
  last_used_at: null,
  created_at: "2026-11-04T10:00:00Z",
  expires_at: null,
  revoked_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
});

describe("createApiKey", () => {
  it("posts the checked name, scopes and expiry and answers the raw key", async () => {
    const created = { ...listed, key: "apl_live_abcdefgsecret" };
    createApiKey.mockResolvedValue(created);
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(await actions.createApiKey("shop", { name: "  Production ", scopes: ["read", "ingest"], expiresAt })).toEqual({ ok: true, key: created });
    expect(createApiKey).toHaveBeenCalledWith("shop", { name: "Production", scopes: ["ingest", "read"], expires_at: expiresAt }, { accessToken: "a" });
  });

  it("omits expires_at for a key that never expires", async () => {
    createApiKey.mockResolvedValue({ ...listed, key: "k" });
    await actions.createApiKey("shop", { name: "CI", scopes: ["ingest"] });
    expect(createApiKey).toHaveBeenCalledWith("shop", { name: "CI", scopes: ["ingest"] }, { accessToken: "a" });
  });

  it("validates before calling the API", async () => {
    expect(await actions.createApiKey("shop", { name: " ", scopes: ["ingest"] })).toEqual({ ok: false, error: "Enter a name." });
    expect(await actions.createApiKey("shop", { name: "CI", scopes: [] })).toMatchObject({ ok: false });
    expect(await actions.createApiKey("shop", { name: "CI", scopes: ["admin"] })).toMatchObject({ ok: false });
    expect(await actions.createApiKey("shop", { name: "CI", scopes: ["ingest"], expiresAt: "2001-01-01T00:00:00Z" })).toMatchObject({ ok: false });
    expect(await actions.createApiKey("../orgs", { name: "CI", scopes: ["ingest"] })).toMatchObject({ ok: false, code: "not_found" });
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("turns API errors into a sentence", async () => {
    createApiKey.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    expect(await actions.createApiKey("shop", { name: "CI", scopes: ["ingest"] })).toEqual({
      ok: false,
      code: "forbidden",
      error: "You don’t have permission to manage this project’s API keys.",
    });
  });

  it("sends an expired session to sign-in", async () => {
    expired = true;
    await expect(actions.createApiKey("shop", { name: "CI", scopes: ["ingest"] })).rejects.toBeInstanceOf(Redirect);
  });
});

describe("revokeApiKey", () => {
  it("revokes and answers the key as listed now", async () => {
    revokeApiKey.mockResolvedValue(undefined);
    const now = { ...listed, revoked_at: "2026-11-04T12:00:00Z" };
    listApiKeys.mockResolvedValue([now]);
    expect(await actions.revokeApiKey("shop", ID)).toEqual({ ok: true, key: now });
    expect(revokeApiKey).toHaveBeenCalledWith("shop", ID, { accessToken: "a" });
  });

  it("still succeeds when the list cannot be read back", async () => {
    revokeApiKey.mockResolvedValue(undefined);
    listApiKeys.mockRejectedValue(new ApiError({ status: 503, code: "unavailable" }));
    expect(await actions.revokeApiKey("shop", ID)).toEqual({ ok: true, key: null });
  });

  it("rejects ids that are not UUIDs without calling the API", async () => {
    expect(await actions.revokeApiKey("shop", "../../users")).toMatchObject({ ok: false, code: "api_key_gone" });
    expect(revokeApiKey).not.toHaveBeenCalled();
  });

  it("turns API errors into a sentence", async () => {
    revokeApiKey.mockRejectedValue(new ApiError({ status: 410, code: "api_key_gone" }));
    expect(await actions.revokeApiKey("shop", ID)).toMatchObject({ ok: false, code: "api_key_gone" });
    expect(listApiKeys).not.toHaveBeenCalled();
  });
});
