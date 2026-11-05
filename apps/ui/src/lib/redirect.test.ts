import { describe, expect, it } from "vitest";
import { redirectTo } from "./redirect";

const BIND = "http://0.0.0.0:3000/api/auth/email/verify-link?token=t";

describe("redirectTo", () => {
  it("keeps a same-site path relative, never the bind address", () => {
    const res = redirectTo("/acme/explore?range=1h", BIND);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/acme/explore?range=1h");
  });

  it("lets the response carry cookies", () => {
    const res = redirectTo("/acme", BIND);
    res.cookies.set("apilens_session", "sealed");
    expect(res.headers.getSetCookie().join(";")).toContain("apilens_session=sealed");
  });

  it("resolves protocol-relative and backslash tricks absolutely instead of trusting them as paths", () => {
    expect(redirectTo("//evil.example/x", BIND).headers.get("location")).toBe("http://evil.example/x");
    expect(redirectTo("/\\evil.example", BIND).headers.get("location")).toMatch(/^http:\/\//);
  });

  it("passes absolute URLs through and honours the status", () => {
    const res = redirectTo("https://idp.example/authorize?x=1", BIND, 307);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://idp.example/authorize?x=1");
  });
});
