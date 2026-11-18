import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const createHealthCheckApi = vi.fn();
const deleteHealthCheckApi = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createHealthCheck: createHealthCheckApi, deleteHealthCheck: deleteHealthCheckApi }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { createHealthCheck, deleteHealthCheck } = await import("./health-check-actions");

const ID = "0b9c3a52-6a3e-4f0e-9d0b-6c2f1e7d8a41";
const INPUT = { app_id: "a1", environment: " production ", url: " https://api.example.com/healthz ", expected_status: "200" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createHealthCheck", () => {
  it("creates the checked check as the signed-in user", async () => {
    const check = { id: ID, url: "https://api.example.com/healthz" };
    createHealthCheckApi.mockResolvedValue(check);
    await expect(createHealthCheck("shop", INPUT)).resolves.toEqual({ ok: true, check });
    expect(createHealthCheckApi).toHaveBeenCalledWith(
      "shop",
      { app_id: "a1", environment: "production", url: "https://api.example.com/healthz", expected_status: 200 },
      { accessToken: "a" },
    );
  });

  it("refuses bad input without calling the API", async () => {
    await expect(createHealthCheck("Not A Slug", INPUT)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(createHealthCheck("shop", { ...INPUT, url: "file:///etc/passwd" })).resolves.toMatchObject({ ok: false, field: "url" });
    expect(createHealthCheckApi).not.toHaveBeenCalled();
  });

  it("shows why the API refused the URL", async () => {
    createHealthCheckApi.mockImplementation(async () => {
      throw new ApiError({ status: 422, code: "validation_failed", problem: { detail: "url must point to a public address" } });
    });
    await expect(createHealthCheck("shop", { ...INPUT, url: "http://10.0.0.5/" })).resolves.toEqual({
      ok: false,
      error: "Not accepted: url must point to a public address.",
      code: "validation_failed",
      field: "url",
    });
  });

  it("answers a sentence for other API errors", async () => {
    createHealthCheckApi.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(createHealthCheck("shop", INPUT)).resolves.toEqual({
      ok: false,
      error: "Only project admins can change health checks. Ask an admin.",
      code: "forbidden",
    });
  });
});

describe("deleteHealthCheck", () => {
  it("deletes as the signed-in user", async () => {
    deleteHealthCheckApi.mockResolvedValue(undefined);
    await expect(deleteHealthCheck("shop", ID)).resolves.toEqual({ ok: true });
    expect(deleteHealthCheckApi).toHaveBeenCalledWith("shop", ID, { accessToken: "a" });
  });

  it("refuses an id that is not one", async () => {
    await expect(deleteHealthCheck("shop", "../x")).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(deleteHealthCheckApi).not.toHaveBeenCalled();
  });
});
