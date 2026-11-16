import { headers } from "next/headers";
import { permanentRedirect } from "next/navigation";
import type { ReactNode } from "react";
import { ProjectStatusProvider } from "@/components/paused-banner";
import { getContext, getSession } from "@/lib/auth/server";
import { type ProjectDetail, identity, isApiError } from "@/lib/identity";
import { PATH_HEADER, renamedPath } from "@/lib/project-redirect";
import { findProject } from "@/lib/scope";
import { isSessionExpired } from "@/lib/server-session";

/** `GET /projects/{slug}` as the signed-in user, or null when the API could not answer. */
async function loadProject(slug: string): Promise<ProjectDetail | null> {
  try {
    const session = await getSession();
    return await session.call((o) => identity().getProject(slug, o));
  } catch (err) {
    if (!isApiError(err) && !isSessionExpired(err)) throw err;
    return null;
  }
}

// Every `/<project>/...` page (#821, #823, #753 D9): a slug the user's projects no longer have may
// be one a rename retired. `GET /projects/{old}` still resolves it and names the current slug, so
// the same page under that slug, query included, is where the link goes (permanently). Anything
// else falls through to the page, which answers 404 as before. For a project the user has, the
// same read says whether its ingest is paused, which the app shell shows as a banner.
export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ project: string }> }) {
  const { project } = await params;
  const path = (await headers()).get(PATH_HEADER);
  // The page's own path, so this shares the page's cached context call.
  const context = await getContext(path?.split("?")[0] || `/${project}`);
  const found = await loadProject(project);

  if (findProject(context, project)) {
    const status = found ? { slug: project, paused: found.paused_at !== null } : null;
    return <ProjectStatusProvider status={status}>{children}</ProjectStatusProvider>;
  }

  const canonical = found ? found.canonical_slug || found.slug : null;
  if (canonical && canonical !== project && findProject(context, canonical)) permanentRedirect(renamedPath(path, project, canonical));
  return children;
}
