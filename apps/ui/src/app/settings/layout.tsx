import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { SectionMenu } from "@/components/shell/section-menu";
import { accountSectionHref } from "@/lib/account-settings";
import { getContext } from "@/lib/auth/server";
import { PATH_HEADER } from "@/lib/project-redirect";
import { accountMenu } from "@/lib/section-menus";

// Account settings' shell and secondary sidebar (#1051): Profile, Security, Sessions, Connected
// accounts, Preferences and Danger zone. Rendered here, not by the page, so both stay mounted
// while you move between sections.
export default async function AccountSettingsLayout({ children }: { children: ReactNode }) {
  const path = (await headers()).get(PATH_HEADER)?.split("?")[0] || accountSectionHref({ slug: "" });
  const context = await getContext(path);
  return (
    <AppShell context={context} view="settings" account menu={<SectionMenu {...accountMenu()} />}>
      {children}
    </AppShell>
  );
}
