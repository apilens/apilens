import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/identity";

const renameApp = vi.fn();
const archiveApp = vi.fn();
const restoreApp = vi.fn();
const acknowledgeApp = vi.fn();
const mergeApp = vi.fn();
const deleteApp = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  identity: () => ({ renameApp, archiveApp, restoreApp, acknowledgeApp, mergeApp, deleteApp }),
}));
vi.mock("@/lib/server-session", async (orig) => {
  const real = await orig<typeof import("@/lib/server-session")>();
  const session = { call: async <T,>(fn: (o: { accessToken: string }) => Promise<T>) => fn({ accessToken: "a" }) };
  return { ...real, withActionSession: async <T,>(fn: (s: typeof session) => Promise<T>) => fn(session) };
});

const actions = await import("./actions");

const ID = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const INTO = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const o = { accessToken: "a" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("app actions", () => {
  it("call the API as the user and revalidate the Apps page", async () => {
    for (const fn of [renameApp, archiveApp, restoreApp, acknowledgeApp, mergeApp, deleteApp]) fn.mockResolvedValue(undefined);
    expect(await actions.renameApp("shop", ID, "  Orders API ")).toEqual({ ok: true });
    expect(renameApp).toHaveBeenCalledWith("shop", ID, "Orders API", o);
    expect(await actions.archiveApp("shop", ID)).toEqual({ ok: true });
    expect(archiveApp).toHaveBeenCalledWith("shop", ID, o);
    expect(await actions.restoreApp("shop", ID)).toEqual({ ok: true });
    expect(await actions.acknowledgeApp("shop", ID)).toEqual({ ok: true });
    expect(await actions.mergeApp("shop", ID, INTO)).toEqual({ ok: true });
    expect(mergeApp).toHaveBeenCalledWith("shop", ID, INTO, o);
    expect(await actions.deleteApp("shop", ID)).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledTimes(6);
    expect(revalidatePath).toHaveBeenCalledWith("/shop/apps");
  });

  it("check their input before calling the API", async () => {
    expect(await actions.renameApp("shop", ID, " ")).toEqual({ ok: false, error: "Enter a name." });
    expect(await actions.archiveApp("shop", "checkout")).toMatchObject({ ok: false, code: "not_found" });
    expect(await actions.deleteApp("../orgs", ID)).toMatchObject({ ok: false, code: "not_found" });
    expect(await actions.mergeApp("shop", ID, ID)).toEqual({ ok: false, error: "Pick an active app other than this one." });
    expect(await actions.mergeApp("shop", ID, "orders")).toMatchObject({ ok: false });
    for (const fn of [renameApp, archiveApp, mergeApp, deleteApp]) expect(fn).not.toHaveBeenCalled();
  });

  it("answer the problem's detail or a sentence for the code, and don't revalidate", async () => {
    const detail = "The default app receives records that name no app; it cannot be archived, merged or deleted.";
    archiveApp.mockRejectedValue(new ApiError({ status: 400, code: "invalid_request", problem: { code: "invalid_request", detail } }));
    expect(await actions.archiveApp("shop", ID)).toEqual({ ok: false, code: "invalid_request", error: detail });
    restoreApp.mockRejectedValue(new ApiError({ status: 403, code: "forbidden", problem: { detail: "Forbidden" } }));
    expect(await actions.restoreApp("shop", ID)).toEqual({ ok: false, code: "forbidden", error: "You don’t have permission to manage this project’s apps. Ask a project admin." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
