import { redirect } from "next/navigation";
import { getContext } from "@/lib/auth/server";
import { orgLanding } from "@/lib/landing";
import { ORG_ROOT } from "@/lib/routes";

// `/org` (Supabase's): the last project's organization, else the first one; onboarding without any.
export default async function OrgIndex() {
  redirect(orgLanding(await getContext(ORG_ROOT)));
}
