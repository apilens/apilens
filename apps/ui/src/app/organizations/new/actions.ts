"use server";

// "Create organization" on /organizations/new. The implementation is shared with onboarding's
// organization step (lib/create-scope.ts).
import { createOrg } from "@/lib/create-scope";
import type { CreateOrgResult } from "@/lib/org-slug";

export async function createOrganization(name: string, slug: string): Promise<CreateOrgResult> {
  return createOrg(name, slug);
}
