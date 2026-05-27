import DashboardLayout from "@/components/dashboard/DashboardLayout";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <DashboardLayout projectSlug={slug}>{children}</DashboardLayout>;
}
