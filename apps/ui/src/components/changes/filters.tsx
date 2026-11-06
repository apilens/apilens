"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";
import type { ChangesFilter } from "@/lib/changes";
import type { NamedApp } from "@/lib/identity";
import { hrefWithoutPage, type SearchParams } from "@/lib/pagination";

/**
 * The app and environment filters of the deploys list. Each change is a navigation to the URL with
 * the new filter and without `page`, so the reader starts again on page 1. A filter value the
 * project no longer lists (a shared link) stays selectable.
 */
export function ChangesFilters({
  pathname,
  params,
  filter,
  apps,
  environments,
}: {
  pathname: string;
  params: SearchParams;
  filter: ChangesFilter;
  apps: NamedApp[] | null;
  environments: readonly string[];
}) {
  const router = useRouter();
  const id = useId();
  const go = (patch: Partial<ChangesFilter>) => router.push(hrefWithoutPage(pathname, params, patch), { scroll: false });
  const envs = filter.env && !environments.includes(filter.env) ? [...environments, filter.env] : environments;
  const appList = apps ?? [];
  const unknownApp = filter.app !== "" && !appList.some((a) => a.id === filter.app);
  return (
    <div className="ch-filters" role="group" aria-label="Filter deploys">
      <div className="ch-field">
        <label htmlFor={`${id}-app`}>App</label>
        <select id={`${id}-app`} className="ch-select" value={filter.app} onChange={(e) => go({ app: e.target.value })} disabled={apps === null && filter.app === ""}>
          <option value="">All apps</option>
          {appList.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {unknownApp ? <option value={filter.app}>Unknown app</option> : null}
        </select>
      </div>
      <div className="ch-field">
        <label htmlFor={`${id}-env`}>Environment</label>
        <select id={`${id}-env`} className="ch-select" value={filter.env} onChange={(e) => go({ env: e.target.value })}>
          <option value="">All environments</option>
          {envs.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
