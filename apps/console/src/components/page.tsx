import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * One per page. Title is the noun the page is about. Controls sit right, in
 * the order filters → range → primary.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
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

/** A KPI row is one panel divided by hairlines, not four floating cards. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 divide-y divide-border rounded-lg border border-border bg-card shadow-panel sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
      <span className="min-h-4 truncate text-xs text-subtle-foreground">{sub}</span>
    </div>
  );
}

/** Segmented control made of links: selection lives in the URL. */
export function Segmented({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; href: string; active: boolean }[];
}) {
  return (
    <nav aria-label={label} className="inline-flex h-8 items-center gap-0.5 rounded-md bg-card p-0.5 shadow-control">
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          scroll={false}
          className={cn(
            "focus-ring inline-flex h-7 items-center rounded-sm px-2.5 text-xs font-medium tabular-nums transition-colors duration-100",
            item.active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** Content placeholder shaped like what it replaces, so nothing jumps. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-skeleton rounded-sm bg-accent", className)} />;
}

/** Inline code: anything a user copies or compares. */
export function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>;
}
