import { notFound, redirect } from "next/navigation";
import { getContext } from "@/lib/auth/server";
import { homeView } from "@/lib/landing";
import { projectHref } from "@/lib/routes";
import { findProject } from "@/lib/scope";

// `/project/<project>` alone opens the project on the user's home view.
export default async function ProjectIndex({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const context = await getContext(projectHref(project));
  if (!findProject(context, project)) notFound();
  redirect(projectHref(project, homeView(context)));
}
