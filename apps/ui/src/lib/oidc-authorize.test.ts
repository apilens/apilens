import { describe, expect, it } from "vitest";
import { decide } from "./auth-gate";
import { OIDC_LOGIN_PATH, endWith, requestId, signInFor, whenSignedOut } from "./oidc-authorize";
import { safeNext } from "./safe-next";

const ID = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CALLBACK = `https://id.example.com/oauth/authorize/callback?id=${ID}`;

describe("oidc authorize", () => {
  it("accepts only request ids", () => {
    expect(requestId(ID)).toBe(ID);
    expect(requestId(ID.toUpperCase())).toBe(ID);
    for (const bad of [null, undefined, "", "abc", `${ID}x`, "../../etc"]) expect(requestId(bad)).toBeNull();
  });

  it("ends a request on identity's callback", () => {
    const url = new URL(endWith({ callback_url: CALLBACK }, "login_required"));
    expect(url.origin + url.pathname).toBe("https://id.example.com/oauth/authorize/callback");
    expect(url.searchParams.get("id")).toBe(ID);
    expect(url.searchParams.get("error")).toBe("login_required");
  });

  it("sends a signed-out user through sign-in and back", () => {
    const location = new URL(signInFor(ID), "https://app.example.com");
    expect(location.pathname).toBe("/sign-in");
    const next = location.searchParams.get("next");
    expect(next).toBe(`${OIDC_LOGIN_PATH}?request_id=${ID}`);
    // The sign-in page keeps it, and the gate returns a signed-in user to it.
    expect(safeNext(next, "")).toBe(next);
    const session = { access: "a", refresh: "r", exp: 2_000_000_000, remember: false, uid: "u" };
    expect(
      decide({ pathname: "/sign-in", search: location.search, session, nowSeconds: 1_000, dev: false }),
    ).toEqual({ action: "redirect", location: next });
  });

  it("answers prompt=none with login_required instead of a sign-in", () => {
    const request = { id: ID, callback_url: CALLBACK };
    expect(whenSignedOut({ ...request, prompt: [] })).toBe(signInFor(ID));
    expect(new URL(whenSignedOut({ ...request, prompt: ["none"] })).searchParams.get("error")).toBe(
      "login_required",
    );
  });

  it("is reachable signed out", () => {
    expect(
      decide({ pathname: OIDC_LOGIN_PATH, search: `?request_id=${ID}`, session: null, nowSeconds: 0, dev: false }),
    ).toEqual({ action: "next", refresh: false });
  });
});
