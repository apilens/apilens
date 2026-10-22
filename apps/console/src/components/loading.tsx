import { Skeleton } from "./page";
import { Panel, PanelHeader } from "./panel";

// Loading shapes mirror the final layout (same heights and column rhythm) so
// nothing jumps when data lands. Announced once to assistive tech.

export function HeaderSkeleton() {
  return (
    <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between" role="status" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-40 rounded-md" />
        <Skeleton className="h-8 w-44 rounded-md" />
      </div>
    </div>
  );
}

export function StatRowSkeleton() {
  return (
    <div className="grid grid-cols-1 divide-y divide-border rounded-lg border border-border bg-card shadow-panel sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 px-4 py-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ title, rows = 8, columns = 6 }: { title: string; rows?: number; columns?: number }) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex h-9 items-center gap-6 px-4">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton key={c} className={c === 1 ? "h-3 flex-1" : "h-3 w-16"} />
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function ChartSkeleton({ title }: { title: string }) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <div className="px-4 pt-4 pb-10">
        <Skeleton className="h-44 w-full" />
      </div>
    </Panel>
  );
}
