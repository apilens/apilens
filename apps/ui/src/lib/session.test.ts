import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as edge from "./session-edge";
import * as node from "./session";
import {
  MAX_COOKIE_LENGTH,
  REMEMBER_MAX_AGE,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  type SessionPayload,
  fromBase64Url,
  toBase64Url,
} from "./session-format";
import fixtures from "./session.vectors.json";

// Both implementations must agree byte-for-byte: the vectors are the contract.
const { secret, vectors } = fixtures;
/** Authentic ciphertext of arbitrary plaintext (bypasses payload validation). */
function encryptRaw(plaintext: string): string {
  const key = hkdfSync("sha256", secret, new Uint8Array(0), "apilens_session/v1", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv);
  cipher.setAAD(Uint8Array.of(1));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "latin1")), cipher.final(), cipher.getAuthTag()]);
  return toBase64Url(Uint8Array.from([1, ...iv, ...body]));
}

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));

const impls = [
  { name: "session (node:crypto)", impl: node, sealWithIv: async (p: SessionPayload, s: string, iv: Uint8Array) => node.sealWithIv(p, s, iv) },
  { name: "session-edge (Web Crypto)", impl: edge, sealWithIv: edge.sealWithIv },
] as const;

const sample: SessionPayload = vectors[0].payload;

/** Every way a cookie can be wrong, derived from a valid one. */
function tamperedVariants(cookie: string): [string, unknown][] {
  const bytes = fromBase64Url(cookie)!;
  const flip = (i: number) => {
    const copy = bytes.slice();
    copy[i] ^= 0x01;
    return toBase64Url(copy);
  };
  const out: [string, unknown][] = [];
  for (let i = 0; i < bytes.length; i++) out.push([`bit flip at byte ${i}`, flip(i)]);
  const withVersion = (v: number) => {
    const copy = bytes.slice();
    copy[0] = v;
    return toBase64Url(copy);
  };
  out.push(
    ["unknown version 0", withVersion(0)],
    ["unknown version 2", withVersion(2)],
    ["truncated by one byte", toBase64Url(bytes.subarray(0, bytes.length - 1))],
    ["tag stripped", toBase64Url(bytes.subarray(0, bytes.length - 16))],
    ["header only", toBase64Url(bytes.subarray(0, 13))],
    ["extra trailing byte", toBase64Url(Uint8Array.from([...bytes, 0]))],
    ["standard base64 alphabet", btoa(String.fromCharCode(...bytes))],
    ["padded", `${cookie}==`],
    ["URL-encoded", encodeURIComponent(`${cookie}+/=`)],
    ["whitespace", ` ${cookie}`],
    ["non-canonical final char", cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A")],
    ["invalid characters", `${cookie.slice(0, 10)}!@#${cookie.slice(13)}`],
    ["length 4n+1", `${cookie}A`.padEnd(Math.ceil(cookie.length / 4) * 4 + 1, "A")],
    ["oversized", "A".repeat(MAX_COOKIE_LENGTH + 4)],
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["object", { cookie }],
  );
  return out;
}

describe.each(impls)("$name", ({ impl, sealWithIv }) => {
  it.each(vectors)("produces the shared vector: $name", async (v) => {
    expect(await sealWithIv(v.payload, secret, fromHex(v.iv))).toBe(v.cookie);
  });

  it.each(vectors)("opens the shared vector: $name", async (v) => {
    expect(await impl.open(v.cookie, secret)).toEqual(v.payload);
  });

  it("round-trips with a random IV", async () => {
    const a = await impl.seal(sample, secret);
    const b = await impl.seal(sample, secret);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await impl.open(a, secret)).toEqual(sample);
    expect(await impl.open(b, secret)).toEqual(sample);
  });

  it("drops unknown payload fields", async () => {
    const cookie = await impl.seal({ ...sample, admin: true } as SessionPayload, secret);
    expect(await impl.open(cookie, secret)).toEqual(sample);
  });

  it("rejects an invalid payload at seal time", async () => {
    for (const bad of [{ ...sample, exp: 1.5 }, { ...sample, uid: "" }, { ...sample, remember: "yes" }, null]) {
      await expect(impl.seal(bad as unknown as SessionPayload, secret)).rejects.toThrow(TypeError);
    }
  });

  it("returns null under a different secret", async () => {
    expect(await impl.open(vectors[0].cookie, `${secret}x`)).toBeNull();
  });

  it.each(tamperedVariants(vectors[0].cookie))("returns null, never throws: %s", async (_name, cookie) => {
    await expect(impl.open(cookie as string, secret)).resolves.toBeNull();
  });

  it.each([
    ["not JSON", "not json"],
    ["JSON array", "[]"],
    ["missing fields", '{"access":"a"}'],
    ["wrong types", '{"access":"a","refresh":"r","exp":"0","remember":false,"uid":"u"}'],
    ["invalid UTF-8", "\xff\xfe"],
  ])("returns null for authentic ciphertext of a bad payload: %s", async (_name, plaintext) => {
    expect(await impl.open(encryptRaw(plaintext), secret)).toBeNull();
  });

  describe("sessionCookieOptions", () => {
    it("is httpOnly, lax, path=/, secure on https, max-age from remember", () => {
      expect(impl.sessionCookieOptions(true, "https://apilens.example.com")).toEqual({
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/",
        maxAge: REMEMBER_MAX_AGE,
      });
      expect(impl.sessionCookieOptions(false, "http://localhost:3200")).toEqual({
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
        maxAge: SESSION_MAX_AGE,
      });
    });
  });

  it("exports the cookie name", () => {
    expect(impl.SESSION_COOKIE_NAME).toBe("apilens_session");
    expect(SESSION_COOKIE_NAME).toBe("apilens_session");
  });
});

describe("defaults from the environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses SESSION_SECRET and APILENS_PUBLIC_URL when no argument is given", async () => {
    vi.stubEnv("APILENS_API_URL", "http://apilens:8080");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("APILENS_PUBLIC_URL", "https://apilens.example.com");
    vi.resetModules();
    const n = await import("./session");
    const e = await import("./session-edge");
    expect(await n.open(vectors[0].cookie)).toEqual(vectors[0].payload);
    expect(await e.open(await n.seal(sample))).toEqual(sample);
    expect(await n.open(await e.seal(sample))).toEqual(sample);
    expect(n.sessionCookieOptions(false).secure).toBe(true);
    expect(e.sessionCookieOptions(true).maxAge).toBe(REMEMBER_MAX_AGE);
  });
});

describe("cross-implementation", () => {
  it("node seals, edge opens and vice versa", async () => {
    expect(await edge.open(await node.seal(sample, secret), secret)).toEqual(sample);
    expect(await node.open(await edge.seal(sample, secret), secret)).toEqual(sample);
  });
});
