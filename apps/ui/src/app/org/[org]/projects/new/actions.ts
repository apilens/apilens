"use server";

// "Create project" on /org/<org>/projects/new. The implementation is shared with onboarding's
// project step (lib/create-scope.ts).
import { createProjectIn } from "@/lib/create-scope";
import type { CreateProjectResult } from "@/lib/project-create";

export async function createProject(org: string, name: string, slug: string, environments: string[]): Promise<CreateProjectResult> {
  return createProjectIn(org, name, slug, environments);
}
