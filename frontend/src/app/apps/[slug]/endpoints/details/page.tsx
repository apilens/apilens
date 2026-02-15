import EndpointDetailsContent from "./EndpointDetailsContent";

export default async function EndpointDetailsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <EndpointDetailsContent appSlug={slug} />;
}
