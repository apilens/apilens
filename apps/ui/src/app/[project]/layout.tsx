import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getContext, getSession } from "@/lib/auth/server";
import { identity, isApiError } from "@/lib/identity";
import { PATH_HEADER, renamedPath } from "@/lib/project-redirect";
import { findProject } from "@/lib/scope";
import { isSessionExpired } from "@/lib/server-session";

// Every `/<project>/...` page (#821, #753 D9): a slug the user's projects no longer have may be one
// a rename retired. `GET /projects/{old}` still resolves it and names the current slug, so the
// same page under that slug is where the link goes. Anything else falls through to the page,
// which answers 404 as before.
export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ project: string }> }) {
  const { project } = await params;
  const path = (await headers()).get(PATH_HEADER);
  // The page's own path, so this shares the page's cached context call.
  const context = await getContext(path?.split("?")[0] || `/${project}`);
  if (findProject(context, project)) return children;

  let canonical: string | null = null;
  try {
    const session = await getSession();
    const found = await session.call((o) => identity().getProject(project, o));
    canonical = found.canonical_slug || found.slug;
  } catch (err) {
    if (!isApiError(err) && !isSessionExpired(err)) throw err;
  }
  if (canonical && canonical !== project && findProject(context, canonical)) redirect(renamedPath(path, project, canonical));
  return children;
}
