import EndpointDetailsContent from "../details/EndpointDetailsContent";

export default async function EndpointDetailsByIdPage({
  params,
}: {
  params: Promise<{ slug: string; endpointId: string }>;
}) {
  const { slug, endpointId } = await params;
  return <EndpointDetailsContent appSlug={slug} endpointId={endpointId} />;
}
