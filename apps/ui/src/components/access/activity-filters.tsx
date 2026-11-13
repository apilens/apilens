"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { type ActivityFilters as Filters, AUDIT_GROUPS, groupLabel } from "@/lib/audit";
import { hrefWithoutPage, type SearchParams } from "@/lib/pagination";

/** A person offered in the Person filter. */
export interface PersonOption {
  id: string;
  name: string;
}

/**
 * The Activity filters (#812): person, action group and a date range, all in the URL. Each change
 * navigates to the URL with the new filter and without the page cursor, so the reader starts
 * again on the newest events. A filter value the lists no longer hold (a shared link) stays
 * selectable.
 */
export function ActivityFilters({
  pathname,
  params,
  filters,
  people,
  groups,
}: {
  pathname: string;
  params: SearchParams;
  filters: Filters;
  people: PersonOption[];
  groups: readonly (typeof AUDIT_GROUPS)[number][];
}) {
  const router = useRouter();
  const id = useId();
  const go = (patch: Partial<Record<keyof Filters, string>>) => router.push(hrefWithoutPage(pathname, params, { cursor: null, ...patch }), { scroll: false });
  const unknownPerson = filters.who && !people.some((p) => p.id === filters.who);
  const unknownGroup = filters.group && !groups.some((g) => g.slug === filters.group);
  const any = !!(filters.who || filters.group || filters.from || filters.to);
  return (
    <div className="acl-filters" role="group" aria-label="Filter activity">
      <div className="acl-field">
        <label htmlFor={`${id}-who`}>Person</label>
        <select id={`${id}-who`} className="acl-select" value={filters.who ?? ""} onChange={(e) => go({ who: e.target.value })}>
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {unknownPerson ? <option value={filters.who}>Someone no longer here</option> : null}
        </select>
      </div>
      <div className="acl-field">
        <label htmlFor={`${id}-group`}>Action</label>
        <select id={`${id}-group`} className="acl-select" value={filters.group ?? ""} onChange={(e) => go({ group: e.target.value })}>
          <option value="">All actions</option>
          {groups.map((g) => (
            <option key={g.slug} value={g.slug}>
              {g.label}
            </option>
          ))}
          {unknownGroup && filters.group ? <option value={filters.group}>{groupLabel(filters.group)}</option> : null}
        </select>
      </div>
      <div className="acl-field">
        <label htmlFor={`${id}-from`}>From</label>
        <input id={`${id}-from`} type="date" className="acl-select acl-date" value={filters.from ?? ""} max={filters.to} onChange={(e) => go({ from: e.target.value })} />
      </div>
      <div className="acl-field">
        <label htmlFor={`${id}-to`}>To</label>
        <input id={`${id}-to`} type="date" className="acl-select acl-date" value={filters.to ?? ""} min={filters.from} onChange={(e) => go({ to: e.target.value })} />
      </div>
      {any ? (
        <Link className="cp-link acl-clear" href={pathname} scroll={false}>
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}
