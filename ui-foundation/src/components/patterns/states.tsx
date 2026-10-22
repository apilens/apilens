import * as React from "react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { WarningOctagonIcon } from "@/components/ui/icon";

// Every data surface ships all four states. Pick the matching one; never
// leave a panel blank, never show a full-page spinner for one panel.

/** No data yet. Says what will appear here and the one action that makes it appear. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      {icon ? <div className="mb-3 text-subtle-foreground [&_svg]:size-5">{icon}</div> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-4 flex gap-2">{action}</div> : null}
    </div>
  );
}

/** What failed, what to do, and a reference id for support. */
export function ErrorState({
  title,
  description,
  requestId,
  action,
  className,
}: {
  title: string;
  description: string;
  requestId?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex items-start gap-3 px-4 py-4", className)}>
      <WarningOctagonIcon className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        {requestId ? <p className="mt-1 font-mono text-2xs text-subtle-foreground">Request {requestId}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** Table-shaped loading state: same row height and column rhythm as the real table. */
export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div aria-busy aria-label="Loading" className="divide-y divide-border">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-9 items-center gap-6 px-4">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn("h-3", c === 0 ? "flex-4" : "flex-1", r % 2 && c === 0 && "max-w-60")} />
          ))}
        </div>
      ))}
    </div>
  );
}
