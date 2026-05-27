import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ProjectEndpointsContent from "./ProjectEndpointsContent";

export const metadata = {
  title: "Endpoints | APILens",
};

export default async function ProjectEndpointsPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;
  return <ProjectEndpointsContent projectSlug={slug} />;
}
