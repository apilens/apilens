import { redirect } from "next/navigation";

export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  redirect(`/orgs/${org}/projects`);
}
