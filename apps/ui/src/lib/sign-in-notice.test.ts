import { describe, expect, it } from "vitest";
import { GENERIC_SIGN_IN_NOTICE, SIGN_IN_NOTICES, signInNotice, withoutNoticeParams } from "./sign-in-notice";

describe("signInNotice", () => {
  it("has copy for every documented code", () => {
    expect(Object.keys(SIGN_IN_NOTICES).sort()).toEqual(
      [
        "account_deleting",
        "oauth_email_unverified",
        "oauth_identity_taken",
        "session_expired",
        "signed_out",
        "sso_required",
      ].sort(),
    );
  });

  it("keeps each notice short, plain and ending in a full stop", () => {
    for (const { text } of [...Object.values(SIGN_IN_NOTICES), GENERIC_SIGN_IN_NOTICE]) {
      expect(text).toMatch(/\.$/);
      expect(text.length).toBeLessThanOrEqual(120);
      expect(text).not.toMatch(/!|error code|oops/i);
    }
  });

  it("returns nothing without a query", () => {
    expect(signInNotice({})).toBeNull();
    expect(signInNotice({ error: "", reason: "" })).toBeNull();
  });

  it("maps known reasons and errors", () => {
    expect(signInNotice({ reason: "session_expired" })).toMatchObject({ code: "session_expired", tone: "warn" });
    expect(signInNotice({ reason: "signed_out" })).toMatchObject({ code: "signed_out", tone: "info" });
    expect(signInNotice({ error: "oauth_identity_taken" })).toMatchObject({ code: "oauth_identity_taken", tone: "error" });
    expect(signInNotice({ error: "sso_required" })?.text).toBe(SIGN_IN_NOTICES.sso_required.text);
  });

  it("shows the generic line for an unknown or malformed error, never the raw value", () => {
    for (const error of ["oauth_state_mismatch_x", "<script>alert(1)</script>", "Your account was hacked", "constructor", "x".repeat(200)]) {
      const n = signInNotice({ error });
      expect(n).toEqual({ code: "unknown", ...GENERIC_SIGN_IN_NOTICE });
      expect(n?.text).not.toContain(error);
    }
    expect(GENERIC_SIGN_IN_NOTICE.text).toBe("Sign-in didn’t complete. Try again.");
  });

  it("ignores an unknown reason", () => {
    expect(signInNotice({ reason: "nope" })).toBeNull();
    expect(signInNotice({ reason: "toString" })).toBeNull();
  });

  it("prefers error over reason and takes the first of repeated params", () => {
    expect(signInNotice({ error: "oauth_email_unverified", reason: "signed_out" })?.code).toBe("oauth_email_unverified");
    expect(signInNotice({ reason: ["session_expired", "signed_out"] })?.code).toBe("session_expired");
  });
});

describe("withoutNoticeParams", () => {
  it("drops error and reason, keeps everything else", () => {
    expect(withoutNoticeParams("https://app.example.com/sign-in?reason=signed_out")).toBe("/sign-in");
    expect(withoutNoticeParams("https://app.example.com/sign-in?error=x&next=%2Fprojects&reason=y#h")).toBe(
      "/sign-in?next=%2Fprojects#h",
    );
  });
});
