import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ProjectDetailContent from "./ProjectDetailContent";

export default async function ProjectDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;
  return <ProjectDetailContent slug={slug} />;
}
