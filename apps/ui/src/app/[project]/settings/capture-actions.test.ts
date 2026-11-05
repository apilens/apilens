import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const putCapturePolicy = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ putCapturePolicy }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { saveCapturePolicy } = await import("./capture-actions");

const APP = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const BODY = { enabled: false, sample_rate: 0.25, capture_headers: true, capture_request_body: false, capture_response_body: true, max_payload_bytes: 4096 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveCapturePolicy", () => {
  it("puts the checked policy as the signed-in user", async () => {
    const saved = { app_id: APP, app: "shop", project: "shop", ...BODY, updated_at: "2026-11-05T10:00:00Z", updated_by: "u1" };
    putCapturePolicy.mockResolvedValue(saved);
    await expect(saveCapturePolicy("shop", APP, BODY)).resolves.toEqual({ ok: true, policy: saved });
    expect(putCapturePolicy).toHaveBeenCalledWith(APP, BODY, { accessToken: "a" });
  });

  it("refuses bad input without calling the API", async () => {
    await expect(saveCapturePolicy("Not A Slug", APP, BODY)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveCapturePolicy("shop", "shop", BODY)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveCapturePolicy("shop", APP, { ...BODY, sample_rate: 2 })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(putCapturePolicy).not.toHaveBeenCalled();
  });

  it("answers a sentence for API errors", async () => {
    putCapturePolicy.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    const result = await saveCapturePolicy("shop", APP, BODY);
    expect(result).toEqual({ ok: false, error: "Only project admins can change the capture policy.", code: "forbidden" });
  });
});
