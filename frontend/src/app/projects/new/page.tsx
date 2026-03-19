import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import StandaloneShell from "@/components/dashboard/StandaloneShell";
import CreateProjectForm from "./CreateProjectForm";

export const metadata = {
  title: "Create Project | APILens",
  description: "Create a new project",
};

export default async function NewProjectPage() {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  return (
    <StandaloneShell>
      <div className="create-app-page">
        <h1 className="create-app-page-title">Create a new project</h1>
        <p className="create-app-page-description">
          Projects group multiple apps and services together.
        </p>
        <CreateProjectForm />
      </div>
    </StandaloneShell>
  );
}
