import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import StandaloneShell from "@/components/dashboard/StandaloneShell";
import ProjectsListContent from "./ProjectsListContent";

export const metadata = {
  title: "Projects | APILens",
  description: "Manage your projects",
};

export default async function ProjectsPage() {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  return (
    <StandaloneShell>
      <ProjectsListContent />
    </StandaloneShell>
  );
}
