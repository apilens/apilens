import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const setProjectMember = vi.fn();
const removeProjectMember = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ setProjectMember, removeProjectMember }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const actions = await import("./actions");

const MAX = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
const VERA = "4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a";
const fail = (status: number, code: string) => async () => {
  throw new ApiError({ status, code });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addProjectMembers", () => {
  it("grants the role to each person and revalidates the page", async () => {
    setProjectMember.mockResolvedValue({});
    const people = [
      { userId: MAX, name: "Max Member" },
      { userId: VERA, name: "Vera Viewer" },
    ];
    await expect(actions.addProjectMembers("shop", people, "editor", "Shop")).resolves.toEqual({ ok: true, message: "Added Max Member and Vera Viewer to Shop as Editors." });
    expect(setProjectMember).toHaveBeenNthCalledWith(1, "shop", MAX, "editor", { accessToken: "a" });
    expect(setProjectMember).toHaveBeenNthCalledWith(2, "shop", VERA, "editor", { accessToken: "a" });
    expect(revalidatePath).toHaveBeenCalledWith("/shop/access");
  });

  it("refuses a bad slug, role, user id, duplicate or empty list without calling the API", async () => {
    const one = [{ userId: MAX, name: "Max" }];
    for (const r of [
      actions.addProjectMembers("Shop!", one, "editor", "Shop"),
      actions.addProjectMembers("shop", one, "owner" as never, "Shop"),
      actions.addProjectMembers("shop", [{ userId: "not-a-uuid", name: "x" }], "editor", "Shop"),
      actions.addProjectMembers("shop", [...one, ...one], "editor", "Shop"),
      actions.addProjectMembers("shop", [], "editor", "Shop"),
      actions.addProjectMembers("shop", "x" as never, "editor", "Shop"),
      actions.addProjectMembers("shop", [null as never], "editor", "Shop"),
    ]) {
      await expect(r).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(setProjectMember).not.toHaveBeenCalled();
  });

  it("passes reauth_required through when nobody was added yet", async () => {
    setProjectMember.mockImplementation(fail(403, "reauth_required"));
    await expect(actions.addProjectMembers("shop", [{ userId: MAX, name: "Max" }], "viewer", "Shop")).resolves.toMatchObject({ ok: false, code: "reauth_required" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says who was added when a later person is refused", async () => {
    setProjectMember.mockResolvedValueOnce({}).mockImplementationOnce(fail(409, "not_org_member"));
    const r = await actions.addProjectMembers("shop", [{ userId: MAX, name: "Max Member" }, { userId: VERA, name: "Vera Viewer" }], "viewer", "Shop");
    expect(r).toMatchObject({ ok: false, code: "not_org_member" });
    expect(r.ok ? "" : r.error).toMatch(/^Added Max Member to Shop as Viewer\. Vera Viewer wasn’t added: /);
    expect(revalidatePath).toHaveBeenCalledWith("/shop/access");
  });
});

describe("changeProjectRole", () => {
  it("sets the direct role", async () => {
    setProjectMember.mockResolvedValue({});
    await expect(actions.changeProjectRole("shop", MAX, "admin", "Max Member", "Shop")).resolves.toEqual({ ok: true, message: "Max Member is now an Admin on Shop." });
    expect(setProjectMember).toHaveBeenCalledWith("shop", MAX, "admin", { accessToken: "a" });
  });

  it("re-validates role and user id", async () => {
    await expect(actions.changeProjectRole("shop", MAX, "superuser" as never, "Max", "Shop")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(actions.changeProjectRole("shop", "../me", "admin", "Max", "Shop")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(setProjectMember).not.toHaveBeenCalled();
  });

  it("answers a sentence for an API refusal", async () => {
    setProjectMember.mockImplementation(fail(403, "forbidden"));
    await expect(actions.changeProjectRole("shop", MAX, "viewer", "Max", "Shop")).resolves.toEqual({ ok: false, error: "Only project admins can change access.", code: "forbidden" });
  });
});

describe("removeProjectMember", () => {
  it("removes the direct role and answers the sentence", async () => {
    removeProjectMember.mockResolvedValue(undefined);
    await expect(actions.removeProjectMember("shop", VERA, "Removed Vera. Vera stays a Viewer through the project default.")).resolves.toEqual({
      ok: true,
      message: "Removed Vera. Vera stays a Viewer through the project default.",
    });
    expect(removeProjectMember).toHaveBeenCalledWith("shop", VERA, { accessToken: "a" });
  });

  it("re-validates the user id and passes reauth_required through", async () => {
    await expect(actions.removeProjectMember("shop", "nope", "x")).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    expect(removeProjectMember).not.toHaveBeenCalled();
    removeProjectMember.mockImplementation(fail(403, "reauth_required"));
    await expect(actions.removeProjectMember("shop", VERA, "x")).resolves.toMatchObject({ ok: false, code: "reauth_required" });
  });
});
