"use server";

// Server Action of project settings → Privacy (#599): replaces the project's server-side deny
// list. It re-checks its input (a Server Action is a public POST endpoint), calls the API as the
// signed-in user and answers a sentence to show, never a raw error. Authorization is the API's
// (owners, admins and members). When the API refuses a pattern, `row` names it.
import { isProjectSlug } from "@/lib/api-keys";
import { type ListKey, checkLists, privacyError, rowOfDetail } from "@/lib/privacy-policy";
import { type PrivacyPolicy, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type SavePrivacyPolicyResult =
  | { ok: true; policy: PrivacyPolicy }
  | { ok: false; error: string; code?: string; row?: { key: ListKey; index: number; reason: string } };

/** Saves `input` as the project-wide privacy policy of `project`. */
export async function savePrivacyPolicy(project: string, input: unknown): Promise<SavePrivacyPolicyResult> {
  if (!isProjectSlug(project)) return { ok: false, error: privacyError("not_found"), code: "not_found" };
  const checked = checkLists(input);
  if (!checked.ok) return { ok: false, error: checked.error, code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const policy = await session.call((o) => identity().putPrivacyPolicy(project, checked.policy, o));
      return { ok: true, policy };
    } catch (err) {
      if (!isApiError(err)) throw err;
      const row = err.code === "invalid_request" ? rowOfDetail(err.problem?.detail) : null;
      return { ok: false, error: privacyError(err.code), code: err.code, ...(row ? { row } : {}) };
    }
  });
}
