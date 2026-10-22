import Link from "next/link";

import { Gated } from "@/components/patterns/gated";
import { PageHeader } from "@/components/patterns/page-header";
import { TenantAvatar } from "@/components/patterns/tenant-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icon";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROLE_LABEL } from "@/lib/capabilities";
import { PROJECTS, orgBySlug } from "@/lib/demo-data";

export default async function OrgProjectsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const org = orgBySlug(slug);
  const projects = PROJECTS.filter((p) => p.orgSlug === org.slug);

  return (
    <>
      <PageHeader
        title="Projects"
        description={`${projects.length} ${projects.length === 1 ? "project" : "projects"} in ${org.name}.`}
        meta={<Badge>{org.plan} plan</Badge>}
        actions={
          <Gated action="project.update">
            <Button variant="primary">
              <PlusIcon />
              Create project
            </Button>
          </Gated>
        }
      />
      <Panel>
        <PanelHeader title="All projects" description="Sorted by name" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Your role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...projects]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => (
                <TableRow key={p.slug}>
                  <TableCell>
                    <Link href={`/projects/${p.slug}`} className="focus-ring flex items-center gap-2 rounded-sm font-medium text-foreground hover:underline">
                      <TenantAvatar name={p.name} slug={p.slug} size="sm" />
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell mono tone="muted">
                    {p.slug}
                  </TableCell>
                  <TableCell tone="muted">{ROLE_LABEL[p.role]}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
