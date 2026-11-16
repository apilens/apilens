"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { envParam, envToRestore, hrefWithEnv, rememberEnv, rememberedEnv } from "@/lib/scope-defaults";

/**
 * Remembers the environment per project (#993). When the URL names one (`explicit`), it is kept as
 * the project's last choice; when the page fell back to the default, the last choice (if the
 * project still has it) replaces the default. Renders nothing.
 */
export function EnvMemory({ project, env, explicit, environments }: { project: string; env: string; explicit: boolean; environments: readonly string[] }) {
  const router = useRouter();
  const known = environments.join("\n");
  useEffect(() => {
    if (explicit) {
      rememberEnv(project, envParam(env));
      return;
    }
    const to = envToRestore(rememberedEnv(project), env, known ? known.split("\n") : []);
    if (to) router.replace(hrefWithEnv(`${window.location.pathname}${window.location.search}`, to), { scroll: false });
  }, [project, env, explicit, known, router]);
  return null;
}
