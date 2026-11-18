import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const putPrivacyPolicy = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ putPrivacyPolicy }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { savePrivacyPolicy } = await import("./privacy-actions");

const BODY = { mask_query_params: [" ^session$ ", ""], mask_headers: ["^x-tenant-"], mask_body_fields: [] };
const SENT = { mask_query_params: ["^session$"], mask_headers: ["^x-tenant-"], mask_body_fields: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("savePrivacyPolicy", () => {
  it("puts the checked lists as the signed-in user", async () => {
    const saved = { app: null, ...SENT, defaults: {}, updated_at: "2026-11-05T10:00:00Z" };
    putPrivacyPolicy.mockResolvedValue(saved);
    await expect(savePrivacyPolicy("shop", BODY)).resolves.toEqual({ ok: true, policy: saved });
    expect(putPrivacyPolicy).toHaveBeenCalledWith("shop", SENT, { accessToken: "a" });
  });

  it("refuses bad input without calling the API", async () => {
    await expect(savePrivacyPolicy("Not A Slug", BODY)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(savePrivacyPolicy("shop", { mask_headers: ["(oops"] })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(savePrivacyPolicy("shop", { mask_headers: "x" })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(putPrivacyPolicy).not.toHaveBeenCalled();
  });

  it("names the row the API refused", async () => {
    putPrivacyPolicy.mockImplementation(async () => {
      throw new ApiError({ status: 400, code: "invalid_request", problem: { detail: "mask_headers[0]: not a valid RE2 pattern" } });
    });
    await expect(savePrivacyPolicy("shop", BODY)).resolves.toEqual({
      ok: false,
      error: "Some patterns weren’t accepted. Fix the highlighted ones and try again.",
      code: "invalid_request",
      row: { key: "mask_headers", index: 0, reason: "not a valid RE2 pattern" },
    });
  });

  it("answers a sentence for other API errors", async () => {
    putPrivacyPolicy.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(savePrivacyPolicy("shop", BODY)).resolves.toEqual({
      ok: false,
      error: "You can’t change this project’s privacy policy. Ask a project admin.",
      code: "forbidden",
    });
  });
});
