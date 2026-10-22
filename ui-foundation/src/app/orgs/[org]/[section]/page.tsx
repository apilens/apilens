import Link from "next/link";
import { notFound } from "next/navigation";

import { ORG_ITEMS } from "@/components/patterns/nav-config";
import { PageHeader } from "@/components/patterns/page-header";
import { EmptyState } from "@/components/patterns/states";
import { Button } from "@/components/ui/button";
import { StackIcon } from "@/components/ui/icon";
import { Panel } from "@/components/ui/panel";
import { orgBySlug } from "@/lib/demo-data";

export default async function OrgSectionPlaceholder({ params }: { params: Promise<{ org: string; section: string }> }) {
  const { org: slug, section } = await params;
  const item = ORG_ITEMS.find((n) => n.href === `/${section}`);
  if (!item) notFound();
  const org = orgBySlug(slug);

  return (
    <>
      <PageHeader title={item.label} description={`${org.name} · not part of the foundation demo.`} />
      <Panel>
        <EmptyState
          icon={<item.icon />}
          title={`${item.label} isn't built in this demo`}
          description="Organization pages hold billing, members and access. Build this one with /new-screen."
          action={
            <Button asChild>
              <Link href={`/orgs/${org.slug}/projects`}>
                <StackIcon />
                Back to projects
              </Link>
            </Button>
          }
        />
      </Panel>
    </>
  );
}
