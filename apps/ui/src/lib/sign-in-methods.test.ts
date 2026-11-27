import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_ONLY, altMethods, toSignInMethods } from "./sign-in-methods";

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

  it("never offers Google or GitHub, however the deployment reports them", () => {
    expect(altMethods({ google: true, github: true, sso: false }, { email: true })).toEqual(["email"]);
    expect(altMethods({ google: true, github: true, sso: false }, { email: false })).toEqual([]);
  });

  it("offers SSO when the deployment has it", () => {
    expect(altMethods({ google: false, github: false, sso: true }, { email: true })).toEqual(["email", "sso"]);
    expect(altMethods({ google: true, github: true, sso: true }, { email: false })).toEqual(["sso"]);
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
