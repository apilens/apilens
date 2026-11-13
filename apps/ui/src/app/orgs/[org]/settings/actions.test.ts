import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type UserContext } from "@/lib/identity";

const updateOrg = vi.fn();
const deleteOrg = vi.fn();
const context = vi.fn();
const revalidatePath = vi.fn();
let expired = false;

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ updateOrg, deleteOrg, context }),
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

const { deleteOrganization, saveOrgDomains, saveOrgName } = await import("./actions");

const org = { id: "o1", slug: "acme", name: "Acme", role: "owner" as const, allowed_domains: [], domain_join: false };

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
});

describe("saveOrgName", () => {
  it("patches the trimmed name and refreshes the shell", async () => {
    updateOrg.mockResolvedValue({ ...org, name: "Acme Inc" });
    const res = await saveOrgName("acme", "  Acme Inc ");
    expect(res).toEqual({ ok: true, org: { ...org, name: "Acme Inc" } });
    expect(updateOrg).toHaveBeenCalledWith("acme", { name: "Acme Inc" }, { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("validates before calling the API", async () => {
    expect(await saveOrgName("acme", "  ")).toMatchObject({ ok: false });
    expect(await saveOrgName("../x", "Acme")).toMatchObject({ ok: false });
    expect(updateOrg).not.toHaveBeenCalled();
  });

  it("turns API errors into a sentence", async () => {
    updateOrg.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    expect(await saveOrgName("acme", "Acme")).toMatchObject({ ok: false, code: "forbidden", error: expect.stringMatching(/permission/) });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sends an expired session to sign-in", async () => {
    expired = true;
    await expect(saveOrgName("acme", "Acme")).rejects.toMatchObject({ to: expect.stringContaining("session_expired") });
  });

  it("does not swallow unexpected errors", async () => {
    updateOrg.mockRejectedValue(new TypeError("boom"));
    await expect(saveOrgName("acme", "Acme")).rejects.toThrow("boom");
  });
});

describe("saveOrgDomains", () => {
  it("sends normalized domains and the toggle", async () => {
    updateOrg.mockResolvedValue({ ...org, allowed_domains: ["acme.com"], domain_join: true });
    const res = await saveOrgDomains("acme", ["ACME.com", "acme.com"], true);
    expect(res.ok).toBe(true);
    expect(updateOrg).toHaveBeenCalledWith("acme", { allowed_domains: ["acme.com"], domain_join: true }, { accessToken: "a" });
  });

  it("turns domain join off when no domain is left", async () => {
    updateOrg.mockResolvedValue(org);
    await saveOrgDomains("acme", [], true);
    expect(updateOrg).toHaveBeenCalledWith("acme", { allowed_domains: [], domain_join: false }, { accessToken: "a" });
  });

  it("rejects malformed input without calling the API", async () => {
    expect(await saveOrgDomains("acme", ["not a domain"], false)).toMatchObject({ ok: false });
    expect(await saveOrgDomains("acme", ["acme.com"], "yes" as never)).toMatchObject({ ok: false });
    expect(updateOrg).not.toHaveBeenCalled();
  });

  it("reports domain_not_allowed from the server", async () => {
    updateOrg.mockRejectedValue(new ApiError({ status: 400, code: "domain_not_allowed" }));
    expect(await saveOrgDomains("acme", ["gmail.com"], false)).toMatchObject({ ok: false, code: "domain_not_allowed" });
  });
});

describe("deleteOrganization", () => {
  const ctx = (slugs: string[]): UserContext =>
    ({
      orgs: slugs.map((slug) => ({
        id: slug,
        slug,
        name: slug,
        role: "owner",
        projects: [{ id: "p", slug: "web", name: "Web", environments: [], app_count: 1 }],
      })),
    }) as unknown as UserContext;

  it("needs the slug typed to confirm", async () => {
    expect(await deleteOrganization("acme", "acm")).toMatchObject({ ok: false });
    expect(deleteOrg).not.toHaveBeenCalled();
  });

  it("deletes and lands in another organization", async () => {
    deleteOrg.mockResolvedValue(undefined);
    context.mockResolvedValue(ctx(["acme", "beta"]));
    await expect(deleteOrganization("acme", "acme")).rejects.toMatchObject({ to: "/web/incidents" });
    expect(deleteOrg).toHaveBeenCalledWith("acme", { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("lands on joining an organization when none is left", async () => {
    deleteOrg.mockResolvedValue(undefined);
    context.mockResolvedValue(ctx([]));
    await expect(deleteOrganization("acme", "acme")).rejects.toMatchObject({ to: "/onboarding/join" });
  });

  it("answers the API's refusal", async () => {
    deleteOrg.mockRejectedValue(new ApiError({ status: 403, code: "forbidden" }));
    expect(await deleteOrganization("acme", "acme")).toMatchObject({ ok: false, code: "forbidden" });
  });
});
