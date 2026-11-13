import { describe, expect, it, vi } from "vitest";
import { CANCELLED, REAUTH_REQUIRED, orderedMethods, reauthError, reauthOptions, reauthWithCode, withReauthRetry } from "./reauth";

type Result = { ok: true } | { ok: false; error: string; code?: string };

const stale: Result = { ok: false, error: "Sign in again", code: REAUTH_REQUIRED };

describe("withReauthRetry", () => {
  it("answers a success without asking", async () => {
    const action = vi.fn(async (): Promise<Result> => ({ ok: true }));
    const confirm = vi.fn(async () => true);
    expect(await withReauthRetry(action, confirm)).toEqual({ ok: true });
    expect(action).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("answers any other failure without asking", async () => {
    const action = vi.fn(async (): Promise<Result> => ({ ok: false, error: "Nope", code: "forbidden" }));
    const confirm = vi.fn(async () => true);
    expect(await withReauthRetry(action, confirm)).toMatchObject({ code: "forbidden" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks once and retries once after reauth_required", async () => {
    const action = vi.fn<() => Promise<Result>>().mockResolvedValueOnce(stale).mockResolvedValueOnce({ ok: true });
    const confirm = vi.fn(async () => true);
    expect(await withReauthRetry(action, confirm)).toEqual({ ok: true });
    expect(action).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("retries only once: a second reauth_required is answered, not looped", async () => {
    const action = vi.fn(async (): Promise<Result> => stale);
    const confirm = vi.fn(async () => true);
    expect(await withReauthRetry(action, confirm)).toEqual(stale);
    expect(action).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("does not rerun the action when the user cancels", async () => {
    const action = vi.fn(async (): Promise<Result> => stale);
    const confirm = vi.fn(async () => false);
    expect(await withReauthRetry(action, confirm)).toBe(CANCELLED);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("answers the retry's own failure", async () => {
    const action = vi
      .fn<() => Promise<Result>>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ ok: false, error: "Gone", code: "api_key_gone" });
    expect(await withReauthRetry(action, async () => true)).toMatchObject({ code: "api_key_gone" });
  });
});

describe("orderedMethods", () => {
  it("offers passkey, then authenticator code, then email, and drops unknown ones", () => {
    expect(orderedMethods(["email", "x", "passkey"])).toEqual(["passkey", "email"]);
    expect(orderedMethods(["totp", "passkey"])).toEqual(["passkey", "totp"]);
  });
});

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("route calls", () => {
  it("reads the options", async () => {
    const fetch = reply(200, { ok: true, next: "/", methods: ["totp", "passkey"], email_code_sent: false, passkey: { challenge_id: "c", options: { publicKey: { challenge: "AA" } } } });
    const r = await reauthOptions({ sendEmailCode: true }, { fetch });
    expect(r).toMatchObject({ ok: true, options: { methods: ["passkey", "totp"], passkey: { challenge_id: "c" }, emailCodeSent: false } });
    expect(JSON.parse(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body))).toEqual({ send_email_code: true });
  });

  it("maps a refused code to its copy", async () => {
    const r = await reauthWithCode("email", " 123456 ", { fetch: reply(401, { ok: false, code: "invalid_code" }) });
    expect(r).toEqual({ ok: false, code: "invalid_code" });
    expect(reauthError("invalid_code")).toMatch(/isn’t right/);
  });

  it("answers network_error when the request fails", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await reauthWithCode("totp", "123456", { fetch })).toEqual({ ok: false, code: "network_error" });
  });

  it("shows nothing for a dismissed passkey sheet and the wait for rate limits", () => {
    expect(reauthError("cancelled")).toBeNull();
    expect(reauthError("rate_limited", 30)).toMatch(/30 seconds/);
  });
});
