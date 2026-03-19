import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export const metadata = {
  title: "Project Settings | APILens",
};

export default async function ProjectSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;
  // Redirect to general tab by default
  redirect(`/projects/${slug}/settings/general`);
}
