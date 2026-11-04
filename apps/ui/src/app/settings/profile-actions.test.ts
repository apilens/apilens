import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const updateMe = vi.fn();
const startEmailChange = vi.fn();
const confirmEmailChange = vi.fn();
const deleteMe = vi.fn();
const me = vi.fn();
const revalidatePath = vi.fn();
const deleteCookie = vi.fn();
let expired = false;

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: (...a: unknown[]) => deleteCookie(...a) }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ updateMe, startEmailChange, confirmEmailChange, deleteMe, me }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = {
    call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => {
      if (expired) throw new real.SessionExpiredError();
      return fn({ accessToken: "a" });
    },
  };
  return {
    ...real,
    // Same contract as the real one, without cookies: an expired session redirects to sign-in.
    withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => {
      try {
        return await fn(session);
      } catch (err) {
        if (real.isSessionExpired(err)) throw new Redirect(real.SESSION_EXPIRED_PATH);
        throw err;
      }
    },
  };
});

const actions = await import("./profile-actions");

const user = { id: "u1", email: "you@example.com", name: "Ada" };

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
});

describe("saveProfileName", () => {
  it("patches the trimmed name and refreshes the shell", async () => {
    updateMe.mockResolvedValue({ ...user, name: "Ada Lovelace" });
    const res = await actions.saveProfileName("  Ada Lovelace ");
    expect(res).toMatchObject({ ok: true, user: { name: "Ada Lovelace" } });
    expect(updateMe).toHaveBeenCalledWith({ name: "Ada Lovelace" }, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("validates before calling the API", async () => {
    expect(await actions.saveProfileName("   ")).toMatchObject({ ok: false });
    expect(await actions.saveProfileName("x".repeat(121))).toMatchObject({ ok: false });
    expect(await actions.saveProfileName(42 as never)).toMatchObject({ ok: false });
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("turns API errors into a sentence", async () => {
    updateMe.mockRejectedValue(new ApiError({ status: 400, code: "invalid_request" }));
    expect(await actions.saveProfileName("Ada")).toMatchObject({ ok: false, code: "invalid_request", error: expect.stringMatching(/\.$/) });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sends an expired session to sign-in", async () => {
    expired = true;
    await expect(actions.saveProfileName("Ada")).rejects.toMatchObject({ to: expect.stringContaining("session_expired") });
  });

  it("does not swallow unexpected errors", async () => {
    updateMe.mockRejectedValue(new TypeError("boom"));
    await expect(actions.saveProfileName("Ada")).rejects.toThrow("boom");
  });
});

describe("requestEmailChange", () => {
  it("asks for a code to the new address", async () => {
    startEmailChange.mockResolvedValue({ pending_email: "new@example.com", expires_at: "2026-11-04T10:15:00Z" });
    const res = await actions.requestEmailChange(" new@example.com ");
    expect(res).toEqual({ ok: true, pendingEmail: "new@example.com", expiresAt: "2026-11-04T10:15:00Z" });
    expect(startEmailChange).toHaveBeenCalledWith({ new_email: "new@example.com" }, { accessToken: "a" });
  });

  it("refuses what cannot be an address", async () => {
    expect(await actions.requestEmailChange("nope")).toMatchObject({ ok: false });
    expect(await actions.requestEmailChange("a b@example.com")).toMatchObject({ ok: false });
    expect(startEmailChange).not.toHaveBeenCalled();
  });

  it("explains email_taken and the current address", async () => {
    startEmailChange.mockRejectedValue(new ApiError({ status: 409, code: "email_taken" }));
    expect(await actions.requestEmailChange("taken@example.com")).toMatchObject({ ok: false, code: "email_taken", error: expect.stringMatching(/already uses/) });
    startEmailChange.mockRejectedValue(new ApiError({ status: 400, code: "invalid_request" }));
    expect(await actions.requestEmailChange("you@example.com")).toMatchObject({ ok: false, error: expect.stringMatching(/different/) });
  });
});

describe("confirmEmailChange", () => {
  it("sends the cleaned code and returns the user", async () => {
    confirmEmailChange.mockResolvedValue({ ...user, email: "new@example.com" });
    const res = await actions.confirmEmailChange("123 456");
    expect(res).toMatchObject({ ok: true, user: { email: "new@example.com" } });
    expect(confirmEmailChange).toHaveBeenCalledWith({ code: "123456" }, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("needs six digits", async () => {
    expect(await actions.confirmEmailChange("12")).toMatchObject({ ok: false });
    expect(confirmEmailChange).not.toHaveBeenCalled();
  });

  it("reports a wrong code and the wait after too many", async () => {
    confirmEmailChange.mockRejectedValue(new ApiError({ status: 400, code: "invalid_code" }));
    expect(await actions.confirmEmailChange("000000")).toMatchObject({ ok: false, code: "invalid_code" });
    confirmEmailChange.mockRejectedValue(new ApiError({ status: 429, code: "too_many_attempts", retryAfter: 30 }));
    expect(await actions.confirmEmailChange("000000")).toMatchObject({ ok: false, code: "too_many_attempts", retryAfter: 30 });
  });
});

describe("deleteAccount", () => {
  it("needs the account's email typed, checked against the account", async () => {
    me.mockResolvedValue(user);
    expect(await actions.deleteAccount("")).toMatchObject({ ok: false });
    expect(await actions.deleteAccount("someone@example.com")).toMatchObject({ ok: false, error: expect.stringContaining("you@example.com") });
    expect(deleteMe).not.toHaveBeenCalled();
    expect(deleteCookie).not.toHaveBeenCalled();
  });

  it("deletes, clears the session cookie and says where to go", async () => {
    me.mockResolvedValue(user);
    deleteMe.mockResolvedValue({ delete_after: "2026-12-04T00:00:00Z" });
    const res = await actions.deleteAccount(" YOU@example.com ");
    expect(res).toEqual({ ok: true, next: "/sign-in?reason=account_deleted", deleteAfter: "2026-12-04T00:00:00Z" });
    expect(deleteMe).toHaveBeenCalledWith({ accessToken: "a" });
    expect(deleteCookie).toHaveBeenCalledTimes(1);
  });

  it("answers owner_transfer_required and keeps the session", async () => {
    me.mockResolvedValue(user);
    deleteMe.mockRejectedValue(new ApiError({ status: 409, code: "owner_transfer_required" }));
    expect(await actions.deleteAccount("you@example.com")).toMatchObject({ ok: false, code: "owner_transfer_required" });
    expect(deleteCookie).not.toHaveBeenCalled();
  });
});
