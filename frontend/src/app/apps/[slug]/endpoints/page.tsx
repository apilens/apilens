import EndpointsContent from "./EndpointsContent";

export default async function EndpointsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <EndpointsContent appSlug={slug} />;
}
