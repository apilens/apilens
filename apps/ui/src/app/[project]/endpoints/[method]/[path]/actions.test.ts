import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const putEndpointSettings = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ putEndpointSettings }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { saveEndpointSettings } = await import("./actions");

const APP = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const BODY = { expected_status_codes: [409, 404], latency_threshold_ms: 250, excluded: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveEndpointSettings", () => {
  it("puts the checked settings as the signed-in user", async () => {
    const saved = { app_id: APP, method: "GET", path: "/orders/{id}", expected_status_codes: [404, 409], latency_threshold_ms: 250, excluded: false, updated_at: "2026-11-05T10:00:00Z" };
    putEndpointSettings.mockResolvedValue(saved);
    await expect(saveEndpointSettings("shop", APP, "get", "/orders/{id}", BODY)).resolves.toEqual({ ok: true, settings: saved });
    expect(putEndpointSettings).toHaveBeenCalledWith(APP, "GET", "/orders/{id}", { ...BODY, expected_status_codes: [404, 409] }, { accessToken: "a" });
  });

  it("refuses bad input without calling the API", async () => {
    await expect(saveEndpointSettings("Not A Slug", APP, "GET", "/x", BODY)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveEndpointSettings("shop", "shop", "GET", "/x", BODY)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveEndpointSettings("shop", APP, "G3T", "/x", BODY)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveEndpointSettings("shop", APP, "GET", "%2Fx", BODY)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveEndpointSettings("shop", APP, "GET", "/x", { ...BODY, latency_threshold_ms: 0 })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(putEndpointSettings).not.toHaveBeenCalled();
  });

  it("answers a sentence for API errors", async () => {
    putEndpointSettings.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(saveEndpointSettings("shop", APP, "GET", "/x", BODY)).resolves.toEqual({ ok: false, error: "Only project admins can change endpoint settings.", code: "forbidden" });
  });
});
