import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import CreateProjectAppForm from "./CreateProjectAppForm";

export default async function NewProjectAppPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;

  return (
    <div className="create-app-page">
      <h1 className="create-app-page-title">Create a new app</h1>
      <p className="create-app-page-description">
        Add a service or microservice to this project.
      </p>
      <CreateProjectAppForm projectSlug={slug} />
    </div>
  );
}
