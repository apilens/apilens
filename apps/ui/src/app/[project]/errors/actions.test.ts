import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const projectApps = vi.fn();
const getEndpointSettings = vi.fn();
const putEndpointSettings = vi.fn();

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ projectApps, getEndpointSettings, putEndpointSettings }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { markStatusExpected } = await import("./actions");

const A = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const B = "0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9";
const settings = (app: string, codes: number[]) => ({ app_id: app, method: "GET", path: "/orders/{id}", expected_status_codes: codes, latency_threshold_ms: 300, excluded: false, updated_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  projectApps.mockResolvedValue({ apps: [{ id: A, slug: "api", name: "API" }, { id: B, slug: "worker", name: "Worker" }] });
  putEndpointSettings.mockImplementation(async (app: string, _m: string, _p: string, body: { expected_status_codes: number[] }) => settings(app, body.expected_status_codes));
});

describe("markStatusExpected", () => {
  it("adds the code for the endpoint in every app, keeping the other settings", async () => {
    getEndpointSettings.mockImplementation(async (_project: string, app: string) => settings(app, app === A ? [409] : []));
    await expect(markStatusExpected("shop", "get", "/orders/{id}", 404)).resolves.toEqual({ ok: true });
    expect(getEndpointSettings).toHaveBeenCalledWith("shop", A, "GET", "/orders/{id}", { accessToken: "a" });
    expect(putEndpointSettings).toHaveBeenCalledWith(A, "GET", "/orders/{id}", { expected_status_codes: [404, 409], latency_threshold_ms: 300, excluded: false }, { accessToken: "a" });
    expect(putEndpointSettings).toHaveBeenCalledWith(B, "GET", "/orders/{id}", { expected_status_codes: [404], latency_threshold_ms: 300, excluded: false }, { accessToken: "a" });
  });

  it("saves nothing for an app where the code already is expected", async () => {
    getEndpointSettings.mockImplementation(async (_project: string, app: string) => settings(app, app === A ? [404] : []));
    await expect(markStatusExpected("shop", "GET", "/orders/{id}", 404)).resolves.toEqual({ ok: true });
    expect(putEndpointSettings).toHaveBeenCalledTimes(1);
    expect(putEndpointSettings.mock.calls[0][0]).toBe(B);
  });

  it("refuses bad input without calling the API", async () => {
    await expect(markStatusExpected("Not A Slug", "GET", "/x", 404)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(markStatusExpected("shop", "G3T", "/x", 404)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(markStatusExpected("shop", "GET", "%2Fx", 404)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(markStatusExpected("shop", "GET", "/x", 200)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(markStatusExpected("shop", "GET", "/x", "404" as unknown as number)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(projectApps).not.toHaveBeenCalled();
  });

  it("says so when the project has no apps", async () => {
    projectApps.mockResolvedValue({ apps: null });
    await expect(markStatusExpected("shop", "GET", "/x", 404)).resolves.toMatchObject({ ok: false, code: "no_apps" });
  });

  it("refuses a 33rd expected code", async () => {
    getEndpointSettings.mockImplementation(async (_project: string, app: string) => settings(app, Array.from({ length: 32 }, (_, i) => 400 + i)));
    await expect(markStatusExpected("shop", "GET", "/x", 500)).resolves.toMatchObject({ ok: false, code: "too_many" });
    expect(putEndpointSettings).not.toHaveBeenCalled();
  });

  it("answers a sentence for API errors", async () => {
    getEndpointSettings.mockImplementation(async (_project: string, app: string) => settings(app, []));
    putEndpointSettings.mockImplementation(async () => {
      throw new ApiError({ status: 403, code: "forbidden" });
    });
    await expect(markStatusExpected("shop", "GET", "/x", 404)).resolves.toEqual({ ok: false, error: "Only project admins can mark status codes as expected.", code: "forbidden" });
  });
});
