import { beforeEach, describe, expect, it, vi } from "vitest";
import { newChannelDraft } from "@/lib/alerts";
import { ApiError } from "@/lib/identity";

const api = {
  createAlertRule: vi.fn(),
  updateAlertRule: vi.fn(),
  deleteAlertRule: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  deleteChannel: vi.fn(),
  testChannel: vi.fn(),
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

const { createChannel, testChannel, updateChannel } = await import("./channel-actions");

const A = { accessToken: "a" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("channel actions", () => {
  it("creates a channel with its config", async () => {
    api.createChannel.mockResolvedValue({ id: "c1" });
    await expect(createChannel("shop", { ...newChannelDraft("email"), name: "On-call", addresses: "oncall@example.com" })).resolves.toEqual({ ok: true, id: "c1" });
    expect(api.createChannel).toHaveBeenCalledWith("shop", { type: "email", name: "On-call", config: { addresses: ["oncall@example.com"] } }, A);
  });

  it("renames without sending a config when its fields are blank", async () => {
    await expect(updateChannel("shop", "c1", { ...newChannelDraft("slack"), name: "Ops" })).resolves.toEqual({ ok: true, id: "c1" });
    expect(api.updateChannel).toHaveBeenCalledWith("shop", "c1", { name: "Ops" }, A);
  });

  it("refuses a channel without a config", async () => {
    await expect(createChannel("shop", { ...newChannelDraft("slack"), name: "Ops" })).resolves.toMatchObject({ ok: false, errors: { webhook_url: expect.any(String) } });
    expect(api.createChannel).not.toHaveBeenCalled();
  });

  it("reports what the channel answered to a test", async () => {
    await expect(testChannel("shop", "c1")).resolves.toEqual({ ok: true });
    api.testChannel.mockRejectedValue(
      new ApiError({ status: 502, code: "unavailable", problem: { status: 502, detail: "the channel did not accept the test notification: alerts: delivery failed: HTTP 410" } }),
    );
    await expect(testChannel("shop", "c1")).resolves.toEqual({
      ok: false,
      error: "The channel didn’t accept the test notification (HTTP 410). Check its settings.",
      code: "unavailable",
    });
  });
});
