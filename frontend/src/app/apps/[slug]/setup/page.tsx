import SetupContent from "./SetupContent";

export default async function AppSetupPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return <SetupContent appSlug={slug} />;
}
