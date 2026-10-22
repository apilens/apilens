import { cookies } from "next/headers";

import { AppShell } from "@/components/patterns/app-shell";
import { Banner } from "@/components/patterns/banner";
import { SIDEBAR_COOKIE } from "@/components/patterns/nav-config";
import { ShieldCheckIcon } from "@/components/ui/icon";
import { actionsFor } from "@/lib/capabilities";
import { projectBySlug } from "@/lib/demo-data";
import { CapabilitiesProvider } from "@/lib/permissions";

export default async function ProjectLayout({ params, children }: { params: Promise<{ slug: string }>; children: React.ReactNode }) {
  const { slug } = await params;
  const project = projectBySlug(slug);
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";

  // Read-only roles get a system banner so the disabled controls below make sense.
  const banner =
    project.role === "viewer" ? (
      <Banner tone="info" icon={<ShieldCheckIcon />}>
        You have view-only access to {project.name}. Ask an admin to change your role.
      </Banner>
    ) : undefined;

  return (
    <CapabilitiesProvider role={project.role} actions={actionsFor(project.role)}>
      <AppShell scope={{ kind: "project", slug: project.slug, orgSlug: project.orgSlug }} defaultCollapsed={collapsed} banner={banner}>
        {children}
      </AppShell>
    </CapabilitiesProvider>
  );
}
