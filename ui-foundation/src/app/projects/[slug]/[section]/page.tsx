import Link from "next/link";
import { notFound } from "next/navigation";

import { PROJECT_ITEMS } from "@/components/patterns/nav-config";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/states";
import { Button } from "@/components/ui/button";
import { SquaresFourIcon } from "@/components/ui/icon";
import { Panel } from "@/components/ui/panel";

// Sections that exist in the real app but not in this foundation demo. They
// render the first-use empty state so navigation never dead-ends in a 404.
export default async function SectionPlaceholder({ params }: { params: Promise<{ slug: string; section: string }> }) {
  const { slug, section } = await params;
  const item = PROJECT_ITEMS.find((n) => n.href === `/${section}`);
  if (!item) notFound();

  return (
    <>
      <PageHeader title={item.label} description="Not part of the foundation demo." />
      <Panel>
        <EmptyState
          icon={<item.icon />}
          title={`${item.label} isn't built in this demo`}
          description="Build it with /new-screen. It will follow the same shell, header and panel structure as Overview."
          action={
            <Button asChild>
              <Link href={`/projects/${slug}`}>
                <SquaresFourIcon />
                Back to overview
              </Link>
            </Button>
          }
        />
      </Panel>
    </>
  );
}
