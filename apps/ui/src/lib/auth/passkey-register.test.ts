import { describe, expect, it, vi } from "vitest";
import { type RegisterEnv, addPasskey, attestationToJSON, canCreatePasskeys, creationOptionsFromJSON } from "./passkey-register";

const bytes = (...b: number[]) => new Uint8Array(b).buffer;

/** A fake attestation as `navigator.credentials.create()` resolves it (no `toJSON`, like old Safari). */
function fakeAttestation(): PublicKeyCredential {
  return {
    id: "AQI",
    rawId: bytes(1, 2),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: { clientDataJSON: bytes(3), attestationObject: bytes(4), getTransports: () => ["internal"] },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;
}

const PUBLIC_KEY = {
  challenge: "AAEC",
  rp: { id: "localhost", name: "APILens" },
  user: { id: "dXNy", name: "you@example.com", displayName: "You" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  excludeCredentials: [{ type: "public-key", id: "AQI" }],
};

const OPTIONS = { ok: true, next: "/settings/security", challenge_id: "ch_1", options: { publicKey: PUBLIC_KEY } };
const PASSKEY = { id: "pk_1", name: "Laptop", authenticator: "", transports: ["internal"] };

type Reply = { status: number; body: unknown };

function env(replies: Reply[], create: (o: CredentialCreationOptions) => Promise<Credential | null> = async () => fakeAttestation()) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const reply = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  });
  const createMock = vi.fn(create);
  const e: RegisterEnv = {
    fetch: fetchMock as unknown as typeof fetch,
    credentials: { create: createMock },
    PublicKeyCredential: function PublicKeyCredential() {} as unknown as RegisterEnv["PublicKeyCredential"],
  };
  return { env: e, calls, createMock };
}

describe("canCreatePasskeys", () => {
  it("needs PublicKeyCredential and credentials.create", () => {
    expect(canCreatePasskeys({})).toBe(false);
    expect(canCreatePasskeys(env([]).env)).toBe(true);
  });
});

describe("creationOptionsFromJSON", () => {
  it("decodes the binary fields by hand without a browser parser", () => {
    const o = creationOptionsFromJSON(PUBLIC_KEY, undefined);
    expect(new Uint8Array(o.challenge as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 2]));
    expect(new TextDecoder().decode(o.user.id as ArrayBuffer)).toBe("usr");
    expect(o.user.name).toBe("you@example.com");
    expect(new Uint8Array(o.excludeCredentials![0].id as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
    expect(o.rp).toEqual({ id: "localhost", name: "APILens" });
  });

  it("uses the browser's parser when there is one", () => {
    const parse = vi.fn(() => ({ parsed: true }) as unknown as PublicKeyCredentialCreationOptions);
    expect(creationOptionsFromJSON(PUBLIC_KEY, { parseCreationOptionsFromJSON: parse })).toEqual({ parsed: true });
    expect(parse).toHaveBeenCalledWith(PUBLIC_KEY);
  });

  it("rejects options without a challenge or user id", () => {
    expect(() => creationOptionsFromJSON({ ...PUBLIC_KEY, challenge: 1 }, undefined)).toThrow(TypeError);
    expect(() => creationOptionsFromJSON({ ...PUBLIC_KEY, user: {} }, undefined)).toThrow(TypeError);
  });
});

describe("attestationToJSON", () => {
  it("serialises by hand without toJSON", () => {
    expect(attestationToJSON(fakeAttestation())).toEqual({
      id: "AQI",
      rawId: "AQI",
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: "Aw", attestationObject: "BA", transports: ["internal"] },
      clientExtensionResults: {},
    });
  });
});

describe("addPasskey", () => {
  it("runs options → create → verify and returns the stored passkey", async () => {
    const { env: e, calls, createMock } = env([
      { status: 200, body: OPTIONS },
      { status: 200, body: { ok: true, next: "/settings/security", passkey: PASSKEY } },
    ]);
    expect(await addPasskey({ name: "  Laptop " }, e)).toEqual({ ok: true, passkey: PASSKEY });
    expect(calls.map((c) => c.url)).toEqual(["/api/auth/passkeys/register/options", "/api/auth/passkeys/register/verify"]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(calls[1].body).toMatchObject({ challenge_id: "ch_1", name: "Laptop", credential: { id: "AQI", response: { attestationObject: "BA" } } });
  });

  it("leaves the name to identity when none is given", async () => {
    const { env: e, calls } = env([
      { status: 200, body: OPTIONS },
      { status: 200, body: { ok: true, next: "/settings/security", passkey: PASSKEY } },
    ]);
    await addPasskey({}, e);
    expect(calls[1].body).not.toHaveProperty("name");
  });

  it("is cancelled when the user dismisses the sheet", async () => {
    const { env: e, calls } = env([{ status: 200, body: OPTIONS }], async () => {
      throw new DOMException("dismissed", "NotAllowedError");
    });
    expect(await addPasskey({}, e)).toEqual({ ok: false, code: "cancelled" });
    expect(calls).toHaveLength(1);
  });

  it("recognises an authenticator that already holds one of the user's passkeys", async () => {
    const { env: e } = env([{ status: 200, body: OPTIONS }], async () => {
      throw new DOMException("excluded", "InvalidStateError");
    });
    expect(await addPasskey({}, e)).toEqual({ ok: false, code: "passkey_already_registered" });
  });

  it("passes the route's code through", async () => {
    const { env: e } = env([
      { status: 200, body: OPTIONS },
      { status: 409, body: { ok: false, code: "passkey_already_registered" } },
    ]);
    expect(await addPasskey({}, e)).toEqual({ ok: false, code: "passkey_already_registered" });
    const expired = env([{ status: 401, body: { ok: false, code: "session_expired" } }]);
    expect(await addPasskey({}, expired.env)).toEqual({ ok: false, code: "session_expired" });
    const down = env([{ status: 502, body: "<html>" }]);
    expect(await addPasskey({}, down.env)).toEqual({ ok: false, code: "server_error" });
  });

  it("reports an unsupported browser and network failures", async () => {
    expect(await addPasskey({}, { fetch: vi.fn() as unknown as typeof fetch })).toEqual({ ok: false, code: "unsupported" });
    const { env: e } = env([]);
    e.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    expect(await addPasskey({}, e)).toEqual({ ok: false, code: "network_error" });
  });
});
