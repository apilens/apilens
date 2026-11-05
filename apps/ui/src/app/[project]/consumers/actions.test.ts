import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const api = {
  createConsumerGroup: vi.fn(),
  renameConsumerGroup: vi.fn(),
  deleteConsumerGroup: vi.fn(),
  assignConsumerGroup: vi.fn(),
  unassignConsumerGroup: vi.fn(),
};

vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => api,
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const { createConsumerGroup, deleteConsumerGroup, renameConsumerGroup, setConsumerGroup } = await import("./actions");

const A = { accessToken: "a" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consumer group actions", () => {
  it("creates, renames and deletes with the trimmed name as the signed-in user", async () => {
    await expect(createConsumerGroup("shop", "  Partners ")).resolves.toEqual({ ok: true });
    expect(api.createConsumerGroup).toHaveBeenCalledWith("shop", "Partners", A);
    await expect(renameConsumerGroup("shop", "g1", "Key partners")).resolves.toEqual({ ok: true });
    expect(api.renameConsumerGroup).toHaveBeenCalledWith("shop", "g1", "Key partners", A);
    await expect(deleteConsumerGroup("shop", "g1")).resolves.toEqual({ ok: true });
    expect(api.deleteConsumerGroup).toHaveBeenCalledWith("shop", "g1", A);
  });

  it("refuses bad input without calling the API", async () => {
    await expect(createConsumerGroup("shop", "  ")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(createConsumerGroup("Not A Slug", "x")).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(renameConsumerGroup("shop", "", "x")).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(deleteConsumerGroup("shop", 7)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(setConsumerGroup("shop", "", "g1")).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(Object.values(api).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("answers a sentence for API errors", async () => {
    api.createConsumerGroup.mockRejectedValue(new ApiError({ status: 409, code: "conflict" }));
    await expect(createConsumerGroup("shop", "Partners")).resolves.toEqual({
      ok: false,
      error: "This project already has a group with that name.",
      code: "conflict",
    });
  });

  it("assigns a group, or takes the consumer out of its group", async () => {
    await expect(setConsumerGroup("shop", "acme/eu", "g2")).resolves.toEqual({ ok: true });
    expect(api.assignConsumerGroup).toHaveBeenCalledWith("shop", "acme/eu", "g2", A);
    await expect(setConsumerGroup("shop", "acme/eu", null)).resolves.toEqual({ ok: true });
    expect(api.unassignConsumerGroup).toHaveBeenCalledWith("shop", "acme/eu", A);
    // Already ungrouped is what was asked for.
    api.unassignConsumerGroup.mockRejectedValue(new ApiError({ status: 404, code: "not_found" }));
    await expect(setConsumerGroup("shop", "acme/eu", null)).resolves.toEqual({ ok: true });
    api.assignConsumerGroup.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    await expect(setConsumerGroup("shop", "acme/eu", "g2")).resolves.toMatchObject({ ok: false, code: "forbidden" });
  });
});
