import { redirect } from "next/navigation";

export default async function EndpointDetailsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/apps/${slug}/endpoints`);
}
