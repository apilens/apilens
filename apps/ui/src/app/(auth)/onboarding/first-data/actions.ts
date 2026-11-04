"use server";

// Server Action of the "Your first requests" step (#335): "Open project" finishes onboarding
// (`PATCH /users/me/onboarding {completed: true}`) and opens the project on the user's home view.
import { redirect } from "next/navigation";
import { isProjectSlug } from "@/lib/api-keys";
import { identity, isApiError } from "@/lib/identity";
import { homeView } from "@/lib/landing";
import { withActionSession } from "@/lib/server-session";

const NOT_FOUND = "We couldn’t find that project. It may have been deleted.";
const FAILED = "We couldn’t finish setup. Try again in a moment.";

/** "Open project": finishes onboarding and opens `/{project}/{home}`. */
export async function openProject(project: string): Promise<{ ok: false; error: string }> {
  if (!isProjectSlug(project)) return { ok: false, error: NOT_FOUND };
  const next = await withActionSession(async (session) => {
    try {
      const ctx = await session.call((o) => identity().context(o));
      if (!ctx.orgs.some((org) => org.projects.some((p) => p.slug === project))) return { ok: false as const, error: NOT_FOUND };
      await session.call((o) => identity().updateOnboarding({ completed: true }, o));
      return `/${project}/${homeView(ctx)}`;
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false as const, error: FAILED };
    }
  });
  if (typeof next !== "string") return next;
  redirect(next);
}
