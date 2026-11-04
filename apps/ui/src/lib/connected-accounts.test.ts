import { describe, expect, it } from "vitest";
import {
  accountName,
  connectedAccountsError,
  connectedNotice,
  formatDate,
  providerRows,
  withoutConnectedParams,
} from "./connected-accounts";
import type { ConnectedAccount } from "./identity";

const account = (over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: "6f1c1a52-3c1e-4c3a-9b6b-0d1d2e3f4a5b",
  provider: "github",
  email: "you@example.com",
  name: "You",
  username: "you",
  avatar_url: "",
  created_at: "2026-03-04T10:00:00Z",
  last_login_at: null,
  ...over,
});

describe("providerRows", () => {
  it("lists Google then GitHub with their accounts and availability", () => {
    const gh = account();
    const rows = providerRows({ google: true, github: false }, [gh]);
    expect(rows.map((r) => [r.provider, r.label, r.available, r.accounts.length])).toEqual([
      ["google", "Google", true, 0],
      ["github", "GitHub", false, 1],
    ]);
    expect(rows[1].accounts[0]).toBe(gh);
  });
});

describe("accountName", () => {
  it("prefers the GitHub login, then the email, then the name", () => {
    expect(accountName(account())).toBe("@you");
    expect(accountName(account({ provider: "google", username: "" }))).toBe("you@example.com");
    expect(accountName(account({ username: "", email: null }))).toBe("You");
    expect(accountName(account({ provider: "google", username: "", email: null, name: "" }))).toBe("Google account");
  });
});

describe("formatDate", () => {
  it("formats in UTC and tolerates missing or bad values", () => {
    expect(formatDate("2026-03-04T23:30:00-05:00")).toBe("Mar 5, 2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate("not a date")).toBe("");
  });
});

describe("connectedNotice", () => {
  it("confirms a connected provider", () => {
    expect(connectedNotice({ linked: "google" })).toMatchObject({ tone: "ok", text: expect.stringContaining("Google account connected") });
  });

  it("explains an account taken by another user", () => {
    expect(connectedNotice({ error: "oauth_identity_taken" })).toMatchObject({
      code: "oauth_identity_taken",
      tone: "error",
      text: expect.stringContaining("different APILens account"),
    });
  });

  it("never echoes the query: unknown values get fixed copy or nothing", () => {
    expect(connectedNotice({ error: "<b>pwned</b>" })).toMatchObject({ code: "unknown", text: "The account couldn’t be connected. Try again." });
    expect(connectedNotice({ linked: "myspace" })).toBeNull();
    expect(connectedNotice({})).toBeNull();
  });

  it("error wins over linked", () => {
    expect(connectedNotice({ linked: "github", error: "oauth_denied" })?.code).toBe("oauth_denied");
  });
});

describe("withoutConnectedParams", () => {
  it("drops linked and error, keeps the rest", () => {
    expect(withoutConnectedParams("http://h/settings/connected-accounts?linked=github&x=1#a")).toBe("/settings/connected-accounts?x=1#a");
    expect(withoutConnectedParams("/settings/connected-accounts?error=oauth_denied")).toBe("/settings/connected-accounts");
  });
});

describe("connectedAccountsError", () => {
  it("has a sentence for every code", () => {
    expect(connectedAccountsError("oauth_identity_gone")).toMatch(/already disconnected/);
    expect(connectedAccountsError("whatever")).toBe("Something went wrong. Try again.");
  });
});
