import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ProjectAppsContent from "../ProjectAppsContent";

export const metadata = {
  title: "Project Apps | APILens",
};

export default async function ProjectAppsPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;
  return <ProjectAppsContent slug={slug} />;
}
