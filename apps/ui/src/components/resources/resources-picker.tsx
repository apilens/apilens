"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";
import { type ResourcesState, resourcesHref } from "@/lib/resources";

/**
 * A select of the Resources tab's scope (environment, or instance) kept in the URL: picking an
 * option loads the tab for it. A shared link may name a value no longer listed; it stays selectable.
 */
export function ResourcesPicker({
  project,
  app,
  state,
  field,
  label,
  all,
  options,
}: {
  project: string;
  app: string;
  state: ResourcesState;
  field: "env" | "instance";
  label: string;
  all: string;
  options: readonly { value: string; label: string }[];
}) {
  const router = useRouter();
  const id = useId();
  const current = state[field];
  const shown = current && !options.some((o) => o.value === current) ? [...options, { value: current, label: current }] : options;
  return (
    <div className="tr-env">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="tr-select"
        value={current}
        onChange={(e) => {
          const next = { ...state, [field]: e.target.value };
          // A new environment may not hold the picked instance.
          if (field === "env") next.instance = "";
          router.push(resourcesHref(project, app, next));
        }}
      >
        <option value="">{all}</option>
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
