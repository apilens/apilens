import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { SectionMenu } from "@/components/shell/section-menu";
import { getContext } from "@/lib/auth/server";
import { PATH_HEADER } from "@/lib/project-redirect";
import { orgHref } from "@/lib/routes";
import { findOrg } from "@/lib/scope";
import { orgSettingsMenu } from "@/lib/section-menus";

// Organization settings' shell and secondary sidebar (#1051): General, SSO and, for owners and
// admins, Audit log. The `(settings)` route group adds nothing to the URL; it only gives these
// three pages one layout, which stays mounted between them. An organization the user is not in
// renders the page alone, which answers 404.
export default async function OrgSettingsLayout({ children, params }: { children: ReactNode; params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const path = (await headers()).get(PATH_HEADER)?.split("?")[0] || orgHref(slug, "general");
  const context = await getContext(path);
  const org = findOrg(context, slug);
  if (!org) return children;
  // Every settings page turns the rail's Organization settings item on, so the view is one of them.
  return (
    <AppShell context={context} org={slug} view="general" menu={<SectionMenu {...orgSettingsMenu(org.slug, org.role)} />}>
      {children}
    </AppShell>
  );
}
