import { REMEMBERED_ACCOUNT_KEY, readRememberedAccount } from "./remembered-account";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetSignIn, lastSignIn, markPending, recordEmailSignIn, rememberSignIn, settlePending } from "./last-signin";

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

afterEach(() => vi.unstubAllGlobals());

function withStorage(store: object) {
  vi.stubGlobal("window", { localStorage: store });
}

describe("last sign-in", () => {
  it("round-trips the method and address, and can be forgotten", () => {
    withStorage(memory());
    expect(lastSignIn()).toBeNull();
    rememberSignIn("github", " ada@example.com ");
    expect(lastSignIn()).toEqual({ method: "github", email: "ada@example.com" });
    forgetSignIn();
    expect(lastSignIn()).toBeNull();
  });

  it("returns null, and never raises, when storage is blocked", () => {
    const deny = () => {
      throw new DOMException("denied", "SecurityError");
    };
    withStorage({ getItem: deny, setItem: deny, removeItem: deny });
    expect(() => rememberSignIn("email", "ada@example.com")).not.toThrow();
    expect(lastSignIn()).toBeNull();
    expect(() => forgetSignIn()).not.toThrow();
  });

  it("returns null when reading localStorage itself throws", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(() => rememberSignIn("email", "ada@example.com")).not.toThrow();
    expect(lastSignIn()).toBeNull();
  });

  it("ignores a stored method it does not know, and junk", () => {
    const s = memory();
    withStorage(s);
    s.m.set("apilens.last-signin", JSON.stringify({ method: "carrier-pigeon", email: "ada@example.com" }));
    expect(lastSignIn()).toBeNull();
    s.m.set("apilens.last-signin", "{not json");
    expect(lastSignIn()).toBeNull();
    s.m.set("apilens.last-signin", JSON.stringify({ method: "email", email: 7 }));
    expect(lastSignIn()).toBeNull();
  });

  it("stores nothing for a value that is not an address", () => {
    const s = memory();
    withStorage(s);
    for (const bad of ["no-at-sign", "@y.co", "a@", "a b@y.co", ""]) rememberSignIn("email", bad);
    expect(s.m.size).toBe(0);
    s.m.set("apilens.last-signin", JSON.stringify({ method: "email", email: "no-at-sign" }));
    expect(lastSignIn()).toBeNull();
  });

  it("records nothing for a blank address", () => {
    withStorage(memory());
    rememberSignIn("email", "   ");
    expect(lastSignIn()).toBeNull();
  });
});

describe("provider sign-ins (leave the page)", () => {
  function browser() {
    const local = memory();
    const tab = memory();
    const jar = { value: "" };
    vi.stubGlobal("window", { localStorage: local, sessionStorage: tab });
    vi.stubGlobal("document", {
      get cookie() {
        return jar.value;
      },
      set cookie(v: string) {
        jar.value = v.includes("Max-Age=0") ? "" : v;
      },
    });
    return jar;
  }

  it("records nothing on click alone, and records the method once the cookie arrives", () => {
    const jar = browser();
    markPending("github");
    expect(lastSignIn()).toBeNull();
    settlePending();
    expect(lastSignIn()).toBeNull();
    jar.value = "apilens_signed_in=ada%40example.com";
    settlePending();
    expect(lastSignIn()).toEqual({ method: "github", email: "ada@example.com" });
    expect(jar.value).toBe("");
  });

  it("ignores the cookie when this tab never started a provider sign-in", () => {
    const jar = browser();
    jar.value = "apilens_signed_in=ada%40example.com";
    settlePending();
    expect(lastSignIn()).toBeNull();
  });
});

describe("settlePending without a readable cookie", () => {
  it("does not raise when document.cookie throws (a sandboxed frame)", () => {
    vi.stubGlobal("window", { localStorage: memory(), sessionStorage: memory() });
    vi.stubGlobal("document", {
      get cookie(): string {
        throw new DOMException("sandboxed", "SecurityError");
      },
    });
    expect(() => settlePending()).not.toThrow();
  });

  function jarBrowser() {
    const local = memory();
    const jar = { value: "" };
    vi.stubGlobal("window", { localStorage: local, sessionStorage: memory() });
    vi.stubGlobal("document", {
      get cookie() {
        return jar.value;
      },
      set cookie(v: string) {
        jar.value = v.includes("Max-Age=0") ? "" : v;
      },
    });
    return jar;
  }

  it("a second factor still to come clears a hint that would now be wrong", () => {
    const jar = jarBrowser();
    rememberSignIn("email", "old@example.com");
    markPending("github");
    jar.value = "apilens_signed_in=2fa";
    settlePending();
    expect(lastSignIn()).toBeNull();
  });

  it("the pending method survives the 2fa marker, so the completed factor records it", () => {
    const jar = jarBrowser();
    markPending("github");
    jar.value = "apilens_signed_in=2fa";
    settlePending();
    expect(lastSignIn()).toBeNull();
    jar.value = "apilens_signed_in=ada%40example.com";
    settlePending();
    expect(lastSignIn()).toEqual({ method: "github", email: "ada@example.com" });
  });

  it("an abandoned second factor records nothing", () => {
    const jar = jarBrowser();
    markPending("github");
    jar.value = "apilens_signed_in=2fa";
    settlePending();
    expect(lastSignIn()).toBeNull();
    expect(readRememberedAccount()).toBeNull();
  });
});

describe("recordEmailSignIn", () => {
  it("a completed sign-in remembers the account and the hint", () => {
    withStorage(memory());
    recordEmailSignIn("signed_in", "ada@example.com");
    expect(lastSignIn()).toEqual({ method: "email", email: "ada@example.com" });
    expect(readRememberedAccount()?.email).toBe("ada@example.com");
  });

  it("one that goes on to a second factor records nothing and clears what named someone else", () => {
    const s = memory();
    withStorage({ ...s });
    vi.stubGlobal("window", { localStorage: s, sessionStorage: memory() });
    rememberSignIn("github", "old@example.com");
    s.m.set(REMEMBERED_ACCOUNT_KEY, JSON.stringify({ email: "old@example.com", at: 1 }));
    recordEmailSignIn("2fa_required", "ada@example.com");
    expect(lastSignIn()).toBeNull();
    expect(readRememberedAccount()).toBeNull();
  });

  it("the completed second factor records both the row and the hint as email", () => {
    const local = memory();
    const jar = { value: "" };
    vi.stubGlobal("window", { localStorage: local, sessionStorage: memory() });
    vi.stubGlobal("document", {
      get cookie() {
        return jar.value;
      },
      set cookie(v: string) {
        jar.value = v.includes("Max-Age=0") ? "" : v;
      },
    });
    recordEmailSignIn("2fa_required", "ada@example.com");
    expect(readRememberedAccount()).toBeNull();
    jar.value = "apilens_signed_in=ada%40example.com";
    settlePending();
    expect(lastSignIn()).toEqual({ method: "email", email: "ada@example.com" });
    expect(readRememberedAccount()).toMatchObject({ email: "ada@example.com", method: "email" });
  });

  it("a later provider click drops an abandoned email second factor's address", () => {
    const local = memory();
    const jar = { value: "" };
    vi.stubGlobal("window", { localStorage: local, sessionStorage: memory() });
    vi.stubGlobal("document", {
      get cookie() {
        return jar.value;
      },
      set cookie(v: string) {
        jar.value = v.includes("Max-Age=0") ? "" : v;
      },
    });
    recordEmailSignIn("2fa_required", "ada@example.com");
    markPending("github");
    jar.value = "apilens_signed_in=bob%40example.com";
    settlePending();
    expect(lastSignIn()).toEqual({ method: "github", email: "bob@example.com" });
    expect(readRememberedAccount()).toBeNull();
  });
});
