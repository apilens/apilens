import ConsumerDetailContent from "./ConsumerDetailContent";

export default async function ConsumerDetailPage({
  params,
}: {
  params: Promise<{ slug: string; consumer: string }>;
}) {
  const { slug, consumer } = await params;
  return <ConsumerDetailContent appSlug={slug} consumerSlug={consumer} />;
}
