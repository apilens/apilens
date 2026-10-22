import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/patterns/app-shell";
import { SIDEBAR_COOKIE } from "@/components/patterns/nav-config";
import { actionsFor } from "@/lib/capabilities";
import { ORGANIZATIONS } from "@/lib/demo-data";
import { CapabilitiesProvider } from "@/lib/permissions";

// Organization scope: billing, members and the project list. Same shell, its own nav.
export default async function OrgLayout({ params, children }: { params: Promise<{ org: string }>; children: React.ReactNode }) {
  const { org: slug } = await params;
  const org = ORGANIZATIONS.find((o) => o.slug === slug);
  if (!org) notFound(); // never confirm an org exists to non-members
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";

  return (
    <CapabilitiesProvider role={org.role} actions={actionsFor(org.role)}>
      <AppShell scope={{ kind: "org", slug: org.slug }} defaultCollapsed={collapsed}>
        {children}
      </AppShell>
    </CapabilitiesProvider>
  );
}
