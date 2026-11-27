import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Organizations } from "@/components/org/organizations";
import { getContext } from "@/lib/auth/server";
import { onboardingPath } from "@/lib/landing";
import { ORGANIZATIONS_PATH } from "@/lib/routes";

export const metadata: Metadata = { title: "Organizations" };

// `/organizations` (Supabase's): every organization the user belongs to, with no rail and no
// organization crumb (account scope, #1051).
export default async function OrganizationsPage() {
  const context = await getContext(ORGANIZATIONS_PATH);
  if (context.orgs.length === 0) redirect(onboardingPath());
  return (
    <AppShell context={context} account view="organizations">
      <Organizations orgs={context.orgs} />
    </AppShell>
  );
}
