"use client";

import { type ReactNode, useState } from "react";
import { reasonPhrase } from "@/lib/http-status";
import { Icon } from "../icons";
import { Item } from "./facet-item";

export type ListRow = { value: string; label: string; count: number; on: boolean; href: string; only: string };

/**
 * A sidebar list with Explore's facet search above it (.exf-search: a 32px box, a search icon,
 * "Search"; Escape clears it): typing keeps the rows whose value or label holds the text. The
 * Status section's codes, matched by code or reason phrase ("404", "not found").
 */
export function SearchableList({ label, rows, codes = false }: { label: string; rows: readonly ListRow[]; codes?: boolean }) {
  const [search, setSearch] = useState("");
  const t = search.trim().toLowerCase();
  const words = (r: ListRow) => `${r.value} ${r.label} ${codes ? reasonPhrase(Number(r.value)) : ""}`.toLowerCase();
  const shown = t ? rows.filter((r) => words(r).includes(t)) : rows;
  const body = (r: ListRow): ReactNode | undefined =>
    codes ? (
      <span className="exf-code">
        <span className="exf-code__num">{r.value}</span>
        {reasonPhrase(Number(r.value)) ? <span className="exf-code__phrase">{reasonPhrase(Number(r.value))}</span> : null}
      </span>
    ) : undefined;
  return (
    <>
      <div className="exf-search">
        <Icon name="search" />
        <input
          type="search"
          aria-label={`Search ${label}`}
          placeholder="Search"
          value={search}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.preventDefault();
              e.stopPropagation();
              setSearch("");
            }
          }}
        />
      </div>
      {shown.length === 0 ? (
        <p className="tr-fnote">Nothing matches “{search}”.</p>
      ) : (
        <ul className="exf-list tr-flist">
          {shown.map((r) => (
            <Item key={r.value} on={r.on} href={r.href} only={r.only} label={r.label} count={r.count} mono={codes} body={body(r)} />
          ))}
        </ul>
      )}
    </>
  );
}
