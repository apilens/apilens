import { describe, expect, it, vi } from "vitest";
import type { ContextOrg, OnboardingState, UserContext } from "./identity";
import {
  acceptInvitation,
  acceptPath,
  expiresIn,
  formatDay,
  formatWait,
  invitationsError,
  inviteAuthPath,
  invitedLanding,
  invitedOrg,
  invitePath,
  inviteProblem,
  inviterName,
  isExpired,
  lastSentAt,
  RESEND_COOLDOWN_MS,
  resendWait,
} from "./invitations";

const created = "2026-11-04T10:00:00Z";
const at = (iso: string) => Date.parse(iso);

describe("resend cooldown", () => {
  it("counts from the last email: resent_at, else created_at", () => {
    expect(lastSentAt({ created_at: created, resent_at: null })).toBe(at(created));
    expect(lastSentAt({ created_at: created, resent_at: "2026-11-04T11:00:00Z" })).toBe(at("2026-11-04T11:00:00Z"));
  });

  it("waits five minutes after the last email", () => {
    const inv = { created_at: created, resent_at: null };
    expect(resendWait(inv, at(created))).toBe(RESEND_COOLDOWN_MS);
    expect(resendWait(inv, at("2026-11-04T10:03:00Z"))).toBe(2 * 60_000);
    expect(resendWait(inv, at("2026-11-04T10:05:00Z"))).toBe(0);
    expect(resendWait(inv, at("2026-11-05T10:00:00Z"))).toBe(0);
    expect(resendWait({ created_at: "garbage", resent_at: null }, 0)).toBe(0);
  });

  it("formats a wait as m:ss, rounding up", () => {
    expect(formatWait(RESEND_COOLDOWN_MS)).toBe("5:00");
    expect(formatWait(245_001)).toBe("4:06");
    expect(formatWait(9_000)).toBe("0:09");
    expect(formatWait(-1)).toBe("0:00");
  });
});

describe("display", () => {
  it("knows when the link expired", () => {
    const inv = { expires_at: "2026-11-11T10:00:00Z" };
    expect(isExpired(inv, at("2026-11-11T09:59:59Z"))).toBe(false);
    expect(isExpired(inv, at("2026-11-11T10:00:00Z"))).toBe(true);
    expect(isExpired({ expires_at: "" }, 0)).toBe(false);
  });

  it("formats days in UTC", () => {
    expect(formatDay("2026-11-11T23:30:00Z")).toBe("Nov 11, 2026");
    expect(formatDay("nope")).toBe("Unknown");
  });

  it("names the inviter", () => {
    expect(inviterName({ invited_by: { id: "u", email: "ada@example.com", name: "Ada Admin" } })).toBe("Ada Admin");
    expect(inviterName({ invited_by: { id: "u", email: "ada@example.com", name: " " } })).toBe("ada@example.com");
    expect(inviterName({})).toBe("—");
  });
});

describe("invitationsError", () => {
  it("has a sentence for every documented code", () => {
    for (const code of ["invite_expired", "rate_limited", "forbidden", "not_found", "invalid_request", "network_error"]) {
      expect(invitationsError(code)).not.toBe(invitationsError("something_new"));
    }
  });
});

const ACME: ContextOrg = {
  id: "o1",
  slug: "acme",
  name: "Acme",
  role: "owner",
  projects: [{ id: "p1", slug: "shop", name: "shop", environments: ["production"], app_count: 1, role: "admin" as const }],
};
const GLOBEX: ContextOrg = {
  id: "o2",
  slug: "globex",
  name: "Globex",
  role: "member",
  projects: [{ id: "p2", slug: "storefront", name: "storefront", environments: ["production"], app_count: 1, role: "admin" as const }],
};

function ctx(onboarding: OnboardingState, orgs: ContextOrg[] = []): UserContext {
  return {
    user: {
      id: "u1",
      email: "grace@example.com",
      email_verified: true,
      name: "Grace Hopper",
      avatar_url: null,
      preferences: {},
      onboarding,
      created_at: "2026-11-01T00:00:00Z",
    },
    orgs,
    last_project_slug: null,
    // The context's own onboarding carries no answers; the user's stored object does.
    onboarding: { step: onboarding.step, completed: onboarding.completed },
    capabilities: {},
  };
}

describe("paths", () => {
  it("encode the token", () => {
    expect(invitePath("a/b?c")).toBe("/invite/a%2Fb%3Fc");
    expect(acceptPath("a/b?c")).toBe("/api/invitations/a%2Fb%3Fc/accept");
  });

  it("sign up by default, sign in when the device remembers an account, then come back", () => {
    expect(inviteAuthPath("tok", false)).toBe(`/sign-up?next=${encodeURIComponent("/invite/tok")}`);
    expect(inviteAuthPath("tok", true)).toBe(`/sign-in?next=${encodeURIComponent("/invite/tok")}`);
  });
});

describe("inviteProblem", () => {
  it.each(["invite_expired", "invalid_token", "invite_email_mismatch"])("keeps %s", (code) => {
    expect(inviteProblem(code)).toBe(code);
  });

  it.each([null, undefined, "", "rate_limited", "server_error"])("%j is a generic error", (code) => {
    expect(inviteProblem(code)).toBe("error");
  });
});

describe("invitedOrg", () => {
  it("is the saved organization the user joined without owning it", () => {
    expect(invitedOrg(ctx({ step: "about", completed: false, answers: { org_slug: "globex" } }, [ACME, GLOBEX]))).toBe(GLOBEX);
  });

  it("is not an organization the user created (owner)", () => {
    expect(invitedOrg(ctx({ step: "about", completed: false, answers: { org_slug: "acme" } }, [ACME]))).toBeUndefined();
  });

  it("needs a saved organization the user belongs to", () => {
    expect(invitedOrg(ctx({ step: "about", completed: false }, [GLOBEX]))).toBeUndefined();
    expect(invitedOrg(ctx({ step: "about", completed: false, answers: { org_slug: "initech" } }, [GLOBEX]))).toBeUndefined();
    expect(invitedOrg(ctx({ step: "about", completed: false, answers: { org_slug: 7 } }, [GLOBEX]))).toBeUndefined();
  });

  it("is nothing once onboarding is finished", () => {
    expect(invitedOrg(ctx({ step: "about", completed: true, answers: { org_slug: "globex" } }, [GLOBEX]))).toBeUndefined();
  });
});

describe("invitedLanding", () => {
  it("opens the organization's first project, or its settings without one", () => {
    const c = ctx({ step: "about", completed: false }, [GLOBEX]);
    expect(invitedLanding(c, GLOBEX)).toBe("/storefront/incidents");
    expect(invitedLanding(c, { ...GLOBEX, projects: [] })).toBe("/orgs/globex/settings");
  });
});

describe("acceptInvitation", () => {
  const accepted = { org: { id: "o2", slug: "globex", name: "Globex", role: "member" as const }, joined: true };

  it("while onboarding: saves the organization at the about step and resumes there", async () => {
    const updateOnboarding = vi.fn().mockResolvedValue({});
    const next = await acceptInvitation({
      accept: async () => accepted,
      context: async () => ctx({ step: null, completed: false }, [GLOBEX]),
      updateOnboarding,
    });
    expect(next).toBe("/onboarding/about");
    expect(updateOnboarding).toHaveBeenCalledWith({ step: "about", answers: { org_slug: "globex" } });
  });

  it("after onboarding: opens the organization's first project and leaves onboarding alone", async () => {
    const updateOnboarding = vi.fn();
    const next = await acceptInvitation({
      accept: async () => ({ ...accepted, joined: false }),
      context: async () => ctx({ step: "invite", completed: true }, [ACME, GLOBEX]),
      updateOnboarding,
    });
    expect(next).toBe("/storefront/incidents");
    expect(updateOnboarding).not.toHaveBeenCalled();
  });

  it("propagates identity's errors without touching onboarding", async () => {
    const err = Object.assign(new Error("mismatch"), { code: "invite_email_mismatch" });
    const context = vi.fn();
    const updateOnboarding = vi.fn();
    await expect(acceptInvitation({ accept: async () => Promise.reject(err), context, updateOnboarding })).rejects.toBe(err);
    expect(context).not.toHaveBeenCalled();
    expect(updateOnboarding).not.toHaveBeenCalled();
  });
});

describe("expiresIn", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  it.each([
    ["2026-11-11T12:00:00Z", "Expires in 7 days"],
    ["2026-11-11T11:59:00Z", "Expires in 7 days"],
    ["2026-11-05T13:00:00Z", "Expires in 1 day"],
    ["2026-11-05T11:00:00Z", "Expires in 23 hours"],
    ["2026-11-04T13:00:00Z", "Expires in 1 hour"],
    ["2026-11-04T12:30:00Z", "Expires within the hour"],
    ["not a date", "Expires within the hour"],
  ])("%s → %s", (at, text) => {
    expect(expiresIn(at, now)).toBe(text);
  });
});
