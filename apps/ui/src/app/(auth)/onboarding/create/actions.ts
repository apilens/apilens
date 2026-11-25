"use server";

// The organization step's Create button (#330). The implementation is shared with
// /organizations/new (lib/create-scope.ts).
import { createOrg } from "@/lib/create-scope";
import type { CreateOrgResult } from "@/lib/org-slug";

export async function createOrganization(name: string, slug: string): Promise<CreateOrgResult> {
  return createOrg(name, slug);
}
