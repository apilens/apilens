"use server";

// The project step's Create button (#331). The implementation is shared with
// /org/<org>/projects/new (lib/create-scope.ts).
import { createProjectIn } from "@/lib/create-scope";
import type { CreateProjectResult } from "@/lib/project-create";

export async function createProject(org: string, name: string, slug: string, environments: string[]): Promise<CreateProjectResult> {
  return createProjectIn(org, name, slug, environments);
}
