import { beforeEach, describe, expect, it, vi } from "vitest";
import { newChannelDraft, newRuleDraft } from "@/lib/alerts";
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

const { createAlertRule, createChannel, deleteAlertRule, testChannel, updateAlertRule, updateChannel } = await import("./actions");

const A = { accessToken: "a" };
const DRAFT = { ...newRuleDraft("app1", "production"), name: " Checkout errors ", threshold: "2", channel_ids: ["c1"] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("alert rule actions", () => {
  it("creates a rule with the checked body as the signed-in user", async () => {
    api.createAlertRule.mockResolvedValue({ id: "r1" });
    await expect(createAlertRule("shop", DRAFT)).resolves.toEqual({ ok: true, id: "r1" });
    expect(api.createAlertRule).toHaveBeenCalledWith(
      "shop",
      expect.objectContaining({ app_id: "app1", name: "Checkout errors", metric: "error_rate", threshold: 0.02, window_s: 300, every_s: 60, channel_ids: ["c1"] }),
      A,
    );
  });

  it("replaces and deletes a rule", async () => {
    await expect(updateAlertRule("shop", "r1", { ...DRAFT, enabled: false })).resolves.toEqual({ ok: true, id: "r1" });
    const body = api.updateAlertRule.mock.calls[0][2];
    expect(body.enabled).toBe(false);
    expect("app_id" in body).toBe(false);
    await expect(deleteAlertRule("shop", "r1")).resolves.toEqual({ ok: true });
    expect(api.deleteAlertRule).toHaveBeenCalledWith("shop", "r1", A);
  });

  it("refuses bad input without calling the API", async () => {
    await expect(createAlertRule("shop", { ...DRAFT, threshold: "abc" })).resolves.toMatchObject({ ok: false, code: "invalid_request", errors: { threshold: expect.any(String) } });
    await expect(createAlertRule("shop", "nonsense")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(createAlertRule("Not A Slug", DRAFT)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(updateAlertRule("shop", "", DRAFT)).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(deleteAlertRule("shop", 7)).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(Object.values(api).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("answers a sentence for API errors", async () => {
    api.createAlertRule.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    await expect(createAlertRule("shop", DRAFT)).resolves.toEqual({ ok: false, error: "Only project admins can change alerts. Ask a project admin.", code: "forbidden" });
  });
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
