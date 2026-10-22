import * as React from "react";

/**
 * One per page. Title is the noun the page is about ("Endpoints"), not a
 * greeting. Page-level controls (time range, env, primary action) go in
 * `actions`, right-aligned, in this order: filters → range → primary.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  description?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          {meta}
        </div>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
