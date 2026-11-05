"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";
import { type TrafficState, trafficHref } from "@/lib/traffic";

/** The environment filter: all environments, or one of the project's. Kept in the URL. */
export function EnvPicker({ project, query, environments }: { project: string; query: TrafficState; environments: readonly string[] }) {
  const router = useRouter();
  const id = useId();
  // A shared link may name an environment the project no longer lists; keep it selectable.
  const options = query.env && !environments.includes(query.env) ? [...environments, query.env] : environments;
  return (
    <div className="tr-env">
      <label htmlFor={id}>Environment</label>
      <select id={id} className="tr-select" value={query.env} onChange={(e) => router.push(trafficHref(project, { ...query, env: e.target.value }))}>
        <option value="">All environments</option>
        {options.map((env) => (
          <option key={env} value={env}>
            {env}
          </option>
        ))}
      </select>
    </div>
  );
}
