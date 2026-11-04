import { describe, expect, it, vi } from "vitest";
import {
  type PasskeyEnv,
  assertionToJSON,
  conditionalMediationAvailable,
  fromBase64Url,
  passkeyError,
  passkeysSupported,
  requestOptionsFromJSON,
  signInWithPasskey,
  toBase64Url,
} from "./passkeys";

const bytes = (...b: number[]) => new Uint8Array(b).buffer;

/** A fake assertion as `navigator.credentials.get()` resolves it (no `toJSON`, like old Safari). */
function fakeAssertion(): PublicKeyCredential {
  return {
    id: "AQI",
    rawId: bytes(1, 2),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: bytes(3),
      authenticatorData: bytes(4),
      signature: bytes(5),
      userHandle: bytes(6),
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;
}

const OPTIONS = {
  ok: true,
  next: "/sign-in",
  challenge_id: "ch_1",
  options: { publicKey: { challenge: "AAEC", rpId: "localhost", allowCredentials: [{ type: "public-key", id: "AQI" }] } },
};

type Reply = { status: number; body: unknown };

function env(replies: Reply[], get: (o?: CredentialRequestOptions) => Promise<unknown>) {
  const queue = [...replies];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const r = queue.shift();
    if (!r) throw new Error("unexpected fetch");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  });
  class PKC {
    static isConditionalMediationAvailable = async () => true;
  }
  const e: PasskeyEnv = {
    fetch: fetchMock as unknown as typeof fetch,
    credentials: { get: vi.fn(get) as unknown as CredentialsContainer["get"] },
    PublicKeyCredential: PKC as unknown as PasskeyEnv["PublicKeyCredential"],
  };
  return { e, fetchMock, get: e.credentials!.get as unknown as ReturnType<typeof vi.fn> };
}

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

describe("feature detection", () => {
  it("needs PublicKeyCredential and credentials.get", () => {
    expect(passkeysSupported({ PublicKeyCredential: undefined, credentials: { get: vi.fn() } })).toBe(false);
    expect(passkeysSupported({ PublicKeyCredential: class {} as never, credentials: undefined })).toBe(false);
    expect(passkeysSupported({ PublicKeyCredential: class {} as never, credentials: { get: vi.fn() } })).toBe(true);
  });

  it("asks isConditionalMediationAvailable, treating a missing or throwing check as no", async () => {
    const creds = { get: vi.fn() };
    class Yes { static isConditionalMediationAvailable = async () => true; }
    class Throws { static isConditionalMediationAvailable = async () => { throw new Error("x"); }; }
    expect(await conditionalMediationAvailable({ PublicKeyCredential: Yes as never, credentials: creds })).toBe(true);
    expect(await conditionalMediationAvailable({ PublicKeyCredential: class {} as never, credentials: creds })).toBe(false);
    expect(await conditionalMediationAvailable({ PublicKeyCredential: Throws as never, credentials: creds })).toBe(false);
    expect(await conditionalMediationAvailable({ PublicKeyCredential: undefined, credentials: creds })).toBe(false);
  });
});

describe("JSON <-> WebAuthn", () => {
  it("round-trips base64url", () => {
    const b = bytes(0xfb, 0xff, 0x00, 0x10);
    expect(toBase64Url(b)).toBe("-_8AEA");
    expect(new Uint8Array(fromBase64Url("-_8AEA"))).toEqual(new Uint8Array(b));
  });

  it("decodes the challenge and allowCredentials ids by hand when the browser has no parser", () => {
    const o = requestOptionsFromJSON(OPTIONS.options.publicKey, undefined);
    expect(new Uint8Array(o.challenge as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 2]));
    expect(o.rpId).toBe("localhost");
    expect(new Uint8Array(o.allowCredentials![0].id as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
    expect(o.allowCredentials![0].type).toBe("public-key");
  });

  it("prefers the browser's parseRequestOptionsFromJSON", () => {
    const parsed = { challenge: bytes(9) } as PublicKeyCredentialRequestOptions;
    const parse = vi.fn(() => parsed);
    expect(requestOptionsFromJSON({ challenge: "CQ" }, { parseRequestOptionsFromJSON: parse })).toBe(parsed);
    expect(parse).toHaveBeenCalledWith({ challenge: "CQ" });
  });

  it("serialises an assertion like toJSON()", () => {
    expect(assertionToJSON(fakeAssertion())).toEqual({
      id: "AQI",
      rawId: "AQI",
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: "Aw", authenticatorData: "BA", signature: "BQ", userHandle: "Bg" },
      clientExtensionResults: {},
    });
  });
});

describe("signInWithPasskey", () => {
  it("runs options -> get -> verify and returns next", async () => {
    const { e, fetchMock, get } = env(
      [
        { status: 200, body: OPTIONS },
        { status: 200, body: { ok: true, next: "/acme/requests" } },
      ],
      async () => fakeAssertion(),
    );
    const res = await signInWithPasskey({ mediation: "optional", email: " ada@example.com ", next: "/acme/requests" }, e);
    expect(res).toEqual({ ok: true, next: "/acme/requests" });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/passkeys/login/options");
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ email: "ada@example.com" });
    const opts = get.mock.calls[0][0] as CredentialRequestOptions;
    expect(opts.mediation).toBe("optional");
    expect(new Uint8Array(opts.publicKey!.challenge as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 2]));

    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/passkeys/login/verify");
    const verify = bodyOf(fetchMock.mock.calls[1]);
    expect(verify).toMatchObject({ challenge_id: "ch_1", next: "/acme/requests", credential: { id: "AQI", type: "public-key" } });
  });

  it("asks for fully discoverable options without an email, passing conditional mediation and the signal", async () => {
    const ctl = new AbortController();
    const { e, fetchMock, get } = env(
      [
        { status: 200, body: OPTIONS },
        { status: 200, body: { ok: true, next: "/" } },
      ],
      async () => fakeAssertion(),
    );
    await signInWithPasskey({ mediation: "conditional", signal: ctl.signal }, e);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({});
    const opts = get.mock.calls[0][0] as CredentialRequestOptions;
    expect(opts.mediation).toBe("conditional");
    expect(opts.signal).toBe(ctl.signal);
  });

  it("reads a dismissed sheet or an aborted request as cancelled", async () => {
    const dismissed = env([{ status: 200, body: OPTIONS }], async () => {
      throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
    });
    expect(await signInWithPasskey({ mediation: "optional" }, dismissed.e)).toEqual({ ok: false, code: "cancelled" });

    const ctl = new AbortController();
    const aborted = env([{ status: 200, body: OPTIONS }], async () => {
      ctl.abort();
      throw new DOMException("aborted", "AbortError");
    });
    expect(await signInWithPasskey({ mediation: "conditional", signal: ctl.signal }, aborted.e)).toEqual({
      ok: false,
      code: "cancelled",
    });
    expect(aborted.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes identity's code through (passkey_unknown)", async () => {
    const { e } = env(
      [
        { status: 200, body: OPTIONS },
        { status: 401, body: { ok: false, code: "passkey_unknown" } },
      ],
      async () => fakeAssertion(),
    );
    expect(await signInWithPasskey({ mediation: "optional" }, e)).toEqual({ ok: false, code: "passkey_unknown" });
  });

  it("maps a failed options call, a transport failure and an off-origin next", async () => {
    const limited = env([{ status: 429, body: { ok: false, code: "rate_limited" } }], async () => fakeAssertion());
    expect(await signInWithPasskey({ mediation: "optional" }, limited.e)).toEqual({ ok: false, code: "rate_limited" });
    expect(limited.get).not.toHaveBeenCalled();

    const bad = env([{ status: 502, body: "<html>bad gateway</html>" }], async () => fakeAssertion());
    expect(await signInWithPasskey({ mediation: "optional" }, bad.e)).toEqual({ ok: false, code: "server_error" });

    const down = env([], async () => fakeAssertion());
    down.e.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await signInWithPasskey({ mediation: "optional" }, down.e)).toEqual({ ok: false, code: "network_error" });

    const evil = env(
      [
        { status: 200, body: OPTIONS },
        { status: 200, body: { ok: true, next: "//evil.example" } },
      ],
      async () => fakeAssertion(),
    );
    expect((await signInWithPasskey({ mediation: "optional" }, evil.e)).ok).toBe(false);
  });

  it("refuses to run without WebAuthn", async () => {
    const f = vi.fn();
    expect(await signInWithPasskey({ mediation: "optional" }, { fetch: f as never })).toEqual({
      ok: false,
      code: "unsupported",
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("passkeyError", () => {
  it("is silent for a cancelled ceremony and explains an unknown passkey", () => {
    expect(passkeyError("cancelled")).toBeNull();
    expect(passkeyError("passkey_unknown")).toBe("No passkey for this account on this device. Use your email instead.");
    expect(passkeyError("passkey_failed")).toContain("didn’t work");
    expect(passkeyError("network_error")).toContain("connection");
    expect(passkeyError("server_error")).toContain("Try again");
  });
});
