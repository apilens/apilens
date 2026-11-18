"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";

export interface PickOption {
  value: string;
  label: string;
  /** The page URL with this option picked. */
  href: string;
}

/**
 * A select whose options are links: picking one opens its URL, so the choice stays in the URL
 * (the endpoint page's environment, status and app pickers).
 */
export function ScopeSelect({ label, value, options }: { label: string; value: string; options: readonly PickOption[] }) {
  const router = useRouter();
  const id = useId();
  return (
    <div className="tr-env">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="tr-select"
        value={value}
        onChange={(e) => {
          const picked = options.find((o) => o.value === e.target.value);
          if (picked) router.push(picked.href);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The scope filters of an analytics page (#1004). On a wide screen they sit in the bar as they
 * are; at phone width they fold behind one "Filters" button (with how many are set), so the data,
 * not a stack of selects, comes first. The button is a disclosure: `aria-expanded` says whether
 * the filters show.
 */
export function ScopeFilters({ active, children }: { active: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`tr-filters${open ? " is-open" : ""}`}>
      <button type="button" className="tr-btn tr-filters__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        Filters
        {active > 0 ? (
          <span className="tr-filters__count">
            <span className="tr-vh">, </span>
            {active}
            <span className="tr-vh"> set</span>
          </span>
        ) : null}
      </button>
      <div id={id} className="tr-bar__scope tr-filters__body">
        {children}
      </div>
    </div>
  );
}
