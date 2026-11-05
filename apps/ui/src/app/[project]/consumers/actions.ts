"use server";

// Server Actions of the Consumers page (#596): create, rename and delete consumer groups, and put
// a consumer in a group (or take it out). Each re-checks its input (a Server Action is a public
// POST endpoint), calls the API as the signed-in user and answers a sentence to show, never a raw
// error. Authorization is the API's (project editors); the UI only hides what the user can't do.
import { isProjectSlug } from "@/lib/api-keys";
import { checkGroupName, groupError } from "@/lib/consumers";
import { identity, isApiError } from "@/lib/identity";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type GroupActionResult = { ok: true } | { ok: false; error: string; code?: string };

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;

async function run(project: unknown, fn: (session: ServerSession, project: string) => Promise<unknown>): Promise<GroupActionResult> {
  if (!isProjectSlug(project)) return { ok: false, error: groupError("not_found"), code: "not_found" };
  return withActionSession(async (session) => {
    try {
      await fn(session, project);
      return { ok: true };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: groupError(err.code), code: err.code };
    }
  });
}

export async function createConsumerGroup(project: string, name: unknown): Promise<GroupActionResult> {
  const checked = checkGroupName(name);
  if (!checked.ok) return { ok: false, error: checked.error, code: "invalid_request" };
  return run(project, (s, p) => s.call((o) => identity().createConsumerGroup(p, checked.name, o)));
}

export async function renameConsumerGroup(project: string, id: unknown, name: unknown): Promise<GroupActionResult> {
  if (!isId(id)) return { ok: false, error: groupError("not_found"), code: "not_found" };
  const checked = checkGroupName(name);
  if (!checked.ok) return { ok: false, error: checked.error, code: "invalid_request" };
  return run(project, (s, p) => s.call((o) => identity().renameConsumerGroup(p, id, checked.name, o)));
}

export async function deleteConsumerGroup(project: string, id: unknown): Promise<GroupActionResult> {
  if (!isId(id)) return { ok: false, error: groupError("not_found"), code: "not_found" };
  return run(project, (s, p) => s.call((o) => identity().deleteConsumerGroup(p, id, o)));
}

/** Puts `consumer` in group `groupId`, moving it out of its previous one; null takes it out. */
export async function setConsumerGroup(project: string, consumer: unknown, groupId: unknown): Promise<GroupActionResult> {
  if (!isId(consumer)) return { ok: false, error: "That consumer no longer exists.", code: "not_found" };
  if (groupId !== null && !isId(groupId)) return { ok: false, error: groupError("not_found"), code: "not_found" };
  return run(project, async (s, p) => {
    if (groupId === null) {
      try {
        await s.call((o) => identity().unassignConsumerGroup(p, consumer, o));
      } catch (err) {
        // Already ungrouped: what was asked for holds.
        if (isApiError(err) && err.code === "not_found") return;
        throw err;
      }
      return;
    }
    await s.call((o) => identity().assignConsumerGroup(p, consumer, groupId, o));
  });
}
