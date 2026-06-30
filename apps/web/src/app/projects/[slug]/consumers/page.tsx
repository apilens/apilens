import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ConsumersContent from "./ConsumersContent";

export const metadata = {
  title: "Consumers | APILens",
};

export default async function ProjectConsumersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;
  return <ConsumersContent projectSlug={slug} />;
}
