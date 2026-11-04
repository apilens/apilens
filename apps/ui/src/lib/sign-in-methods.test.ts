import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_ONLY, altMethods, gridColumns, toSignInMethods } from "./sign-in-methods";

const providers = vi.fn();
const requestHeaders = new Headers({ "x-request-id": "req-312", "user-agent": "vitest" });

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("./identity", async (orig) => ({
  ...(await orig<typeof import("./identity")>()),
  identity: () => ({ providers }),
}));

describe("toSignInMethods", () => {
  it("keeps only the optional methods", () => {
    expect(toSignInMethods({ email: true, passkeys: true, google: true, github: false, sso: true })).toEqual({
      google: true,
      github: false,
      sso: true,
    });
  });

  it("treats missing or non-boolean flags as off", () => {
    expect(toSignInMethods(null)).toEqual(EMAIL_ONLY);
    expect(toSignInMethods({ google: "yes" as unknown as boolean })).toEqual(EMAIL_ONLY);
  });
});

describe("altMethods", () => {
  it("1 method: email code only on a bare self-host", () => {
    expect(altMethods(EMAIL_ONLY, { email: true })).toEqual(["email"]);
    expect(altMethods(EMAIL_ONLY, { email: false })).toEqual([]);
  });

  it("2 methods: email plus the one configured provider", () => {
    expect(altMethods({ google: true, github: false, sso: false }, { email: true })).toEqual(["email", "google"]);
    expect(altMethods({ google: false, github: true, sso: false }, { email: true })).toEqual(["email", "github"]);
  });

  it("3+ methods in a stable order", () => {
    expect(altMethods({ google: true, github: true, sso: false }, { email: true })).toEqual(["email", "github", "google"]);
    expect(altMethods({ google: true, github: true, sso: true }, { email: false })).toEqual(["github", "google", "sso"]);
  });
});

describe("gridColumns", () => {
  it("gives one equal column per button", () => {
    expect(gridColumns(1)).toBe("repeat(1, minmax(0, 1fr))");
    expect(gridColumns(3)).toBe("repeat(3, minmax(0, 1fr))");
  });

  it("never emits an empty grid", () => {
    expect(gridColumns(0)).toBe("repeat(1, minmax(0, 1fr))");
  });
});

describe("signInMethods (server loader)", () => {
  beforeEach(() => {
    providers.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("maps the providers response and forwards the request context", async () => {
    providers.mockResolvedValue({ email: true, passkeys: true, google: false, github: true, sso: false });
    const { signInMethods } = await import("./sign-in-providers");
    await expect(signInMethods()).resolves.toEqual({ google: false, github: true, sso: false });
    expect(providers).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-312", userAgent: "vitest" }));
  });

  it("falls back to email code only when the backend fails", async () => {
    providers.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { signInMethods } = await import("./sign-in-providers");
    await expect(signInMethods()).resolves.toEqual(EMAIL_ONLY);
  });
});
