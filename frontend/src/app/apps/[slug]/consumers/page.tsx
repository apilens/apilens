import ConsumersContent from "./ConsumersContent";

export default async function ConsumersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <ConsumersContent appSlug={slug} />;
}
