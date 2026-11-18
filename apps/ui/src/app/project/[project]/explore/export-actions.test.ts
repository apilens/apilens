import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const createRequestExport = vi.fn();
const cancelRequestExport = vi.fn();

vi.mock("@/lib/env", () => ({ env: () => ({ publicApiUrl: "https://api.example.com" }) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ createRequestExport, cancelRequestExport }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const actions = await import("./export-actions");

const ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const QUEUED = { id: ID, status: "queued", download_url: null };
const DONE = { id: ID, status: "completed", download_url: `/api/v1/exports/${ID}/download?expires=1&signature=s` };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startRequestExport", () => {
  it("starts an export with the range and the filters the log reads, as the signed-in user", async () => {
    createRequestExport.mockResolvedValue(QUEUED);
    await expect(actions.startRequestExport("shop", { range: "6h", filters: { env: "production", status: "5XX", latency_min: "250", bogus: "x", method: "g3t" } })).resolves.toEqual({
      ok: true,
      export: QUEUED,
    });
    expect(createRequestExport).toHaveBeenCalledWith("shop", { range: "6h", env: "production", status: "5xx", latency_min: 250 }, { accessToken: "a" });
  });

  it("falls back to the default range and makes the download link absolute", async () => {
    createRequestExport.mockResolvedValue(DONE);
    await expect(actions.startRequestExport("shop", { range: "30d" })).resolves.toEqual({
      ok: true,
      export: { ...DONE, download_url: `https://api.example.com/api/v1/exports/${ID}/download?expires=1&signature=s` },
    });
    expect(createRequestExport).toHaveBeenCalledWith("shop", { range: "1h" }, { accessToken: "a" });
  });

  it("refuses a bad project without calling the API and answers a sentence for API errors", async () => {
    await expect(actions.startRequestExport("Not A Slug", {})).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(createRequestExport).not.toHaveBeenCalled();
    createRequestExport.mockImplementation(async () => {
      throw new ApiError({ status: 503, code: "unavailable" });
    });
    await expect(actions.startRequestExport("shop", {})).resolves.toEqual({ ok: false, error: "Exports aren’t available right now. Try again in a moment.", code: "unavailable" });
  });
});

describe("cancelRequestExport", () => {
  it("cancels the export as the signed-in user", async () => {
    cancelRequestExport.mockResolvedValue({ ...QUEUED, status: "cancelled" });
    await expect(actions.cancelRequestExport(ID)).resolves.toEqual({ ok: true, export: { ...QUEUED, status: "cancelled" } });
    expect(cancelRequestExport).toHaveBeenCalledWith(ID, { accessToken: "a" });
  });

  it("refuses an id that is not an export's, and says when it already finished", async () => {
    await expect(actions.cancelRequestExport("../x")).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(cancelRequestExport).not.toHaveBeenCalled();
    cancelRequestExport.mockImplementation(async () => {
      throw new ApiError({ status: 409, code: "conflict" });
    });
    await expect(actions.cancelRequestExport(ID)).resolves.toEqual({ ok: false, error: "The export already finished, so there is nothing to cancel.", code: "conflict" });
  });
});
