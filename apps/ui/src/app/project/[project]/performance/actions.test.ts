import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const putAppSettings = vi.fn();
const getAppSettings = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ putAppSettings, getAppSettings }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { loadAppThreshold, saveAppThreshold } = await import("./actions");

const APP = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveAppThreshold", () => {
  it("puts the threshold as the signed-in user", async () => {
    const saved = { app_id: APP, latency_threshold_ms: 250, apdex_threshold_ms: 250 };
    putAppSettings.mockResolvedValue(saved);
    await expect(saveAppThreshold("shop", APP, 250)).resolves.toEqual({ ok: true, settings: saved });
    expect(putAppSettings).toHaveBeenCalledWith(APP, { latency_threshold_ms: 250 }, { accessToken: "a" });
  });

  it("clears the threshold with null", async () => {
    putAppSettings.mockResolvedValue({ app_id: APP, latency_threshold_ms: null, apdex_threshold_ms: 500 });
    await expect(saveAppThreshold("shop", APP, null)).resolves.toMatchObject({ ok: true });
    expect(putAppSettings).toHaveBeenCalledWith(APP, { latency_threshold_ms: null }, { accessToken: "a" });
  });

  it("refuses bad input without calling the API", async () => {
    await expect(saveAppThreshold("Not A Slug", APP, 250)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(saveAppThreshold("shop", "shop", 250)).resolves.toMatchObject({ ok: false, code: "not_found" });
    for (const bad of [0, 600_001, 2.5, "250", undefined]) {
      await expect(saveAppThreshold("shop", APP, bad)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(putAppSettings).not.toHaveBeenCalled();
  });

  it("answers a sentence for API errors", async () => {
    putAppSettings.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(saveAppThreshold("shop", APP, 250)).resolves.toEqual({
      ok: false,
      error: "Only project admins can change the response time threshold.",
      code: "forbidden",
    });
  });
});

describe("loadAppThreshold", () => {
  it("reads the app's threshold as the signed-in user, for the settings dialog's app picker (#976)", async () => {
    const settings = { app_id: APP, latency_threshold_ms: 300, apdex_threshold_ms: 300 };
    getAppSettings.mockResolvedValue(settings);
    await expect(loadAppThreshold("shop", APP)).resolves.toEqual({ ok: true, settings });
    expect(getAppSettings).toHaveBeenCalledWith("shop", APP, { accessToken: "a" });
  });

  it("refuses bad input without calling the API, and answers a sentence for API errors", async () => {
    await expect(loadAppThreshold("shop", "billing")).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(getAppSettings).not.toHaveBeenCalled();
    getAppSettings.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(loadAppThreshold("shop", APP)).resolves.toEqual({
      ok: false,
      error: "We couldn’t load this app’s response time threshold just now. Try again in a moment.",
      code: "forbidden",
    });
  });
});
