"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";

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
