"use server";

// Server Actions of Access › Members (#807): add people with a direct role, change it, remove it.
// Each re-checks its input (a Server Action is a public POST endpoint): the project slug, user ids
// as UUIDs and the role as admin/editor/viewer. The API decides who may (`manage_access`) and asks
// for a recent sign-in (`reauth_required`, D12), which the client answers with the reauth dialog
// and one retry. Results are a sentence for the status line, never a raw error.
import { revalidatePath } from "next/cache";
import { MAX_ADD, accessChangeError, addedMessage, changedMessage, isProjectRole, isProjectSlug, isUserId } from "@/lib/access-changes";
import { type ProjectRole, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type AccessActionResult = { ok: true; message: string } | { ok: false; error: string; code?: string };

const invalid = (): AccessActionResult => ({ ok: false, error: accessChangeError("invalid_request"), code: "invalid_request" });
const failure = (code: string): AccessActionResult => ({ ok: false, error: accessChangeError(code), code });
const label = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : fallback);
const page = (project: string) => `/${project}/access`;

/** One person to add: their user id and the name the status line uses. */
export interface AddPerson {
  userId: string;
  name: string;
}

/**
 * Gives each person `role` on the project, one after another. Stops at the first refusal; the
 * people added before it stay added and the sentence says so. A `reauth_required` before anyone
 * was added answers that code, so the client can confirm and retry the whole save once.
 */
export async function addProjectMembers(project: string, people: AddPerson[], role: ProjectRole, projectName: string): Promise<AccessActionResult> {
  if (!isProjectSlug(project) || !isProjectRole(role)) return invalid();
  if (!Array.isArray(people) || people.length === 0 || people.length > MAX_ADD) return invalid();
  if (!people.every((p) => typeof p === "object" && p !== null && isUserId(p.userId))) return invalid();
  if (new Set(people.map((p) => p.userId.toLowerCase())).size !== people.length) return invalid();
  const where = label(projectName, "the project");
  return withActionSession(async (session) => {
    const added: string[] = [];
    for (const p of people) {
      try {
        await session.call((o) => identity().setProjectMember(project, p.userId, role, o));
        added.push(label(p.name, "Someone"));
      } catch (err) {
        if (!isApiError(err)) throw err;
        if (added.length === 0) return failure(err.code);
        revalidatePath(page(project));
        return { ok: false, error: `${addedMessage(added, role, where)} ${label(p.name, "The next person")} wasn’t added: ${accessChangeError(err.code)}`, code: err.code };
      }
    }
    revalidatePath(page(project));
    return { ok: true, message: addedMessage(added, role, where) };
  });
}

/** Sets the person's direct role on the project. */
export async function changeProjectRole(project: string, userId: string, role: ProjectRole, name: string, projectName: string): Promise<AccessActionResult> {
  if (!isProjectSlug(project) || !isUserId(userId) || !isProjectRole(role)) return invalid();
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().setProjectMember(project, userId, role, o));
    } catch (err) {
      if (!isApiError(err)) throw err;
      return failure(err.code);
    }
    revalidatePath(page(project));
    return { ok: true, message: changedMessage(label(name, "The person"), role, label(projectName, "the project")) };
  });
}

/**
 * Removes the person's direct role. `message` is the sentence the client composed from what the
 * person keeps (it only shows it); the API decides what actually happens.
 */
export async function removeProjectMember(project: string, userId: string, message: string): Promise<AccessActionResult> {
  if (!isProjectSlug(project) || !isUserId(userId)) return invalid();
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().removeProjectMember(project, userId, o));
    } catch (err) {
      if (!isApiError(err)) throw err;
      return failure(err.code);
    }
    revalidatePath(page(project));
    return { ok: true, message: label(message, "Removed.") };
  });
}
