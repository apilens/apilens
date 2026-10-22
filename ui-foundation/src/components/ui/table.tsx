import * as React from "react";

import { cn } from "@/lib/utils";

// Dense data table: 36px rows, hairline row dividers, no zebra stripes, no
// vertical rules. Numbers right-aligned in tabular figures; identifiers
// (paths, ids, keys) in mono. Header labels are sentence case.

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-border [&_tr]:hover:bg-transparent", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn("h-9 border-b border-border transition-colors duration-100 hover:bg-muted/60 data-[state=selected]:bg-accent", className)}
      {...props}
    />
  );
}

export function TableHead({ className, numeric, ...props }: React.ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      className={cn(
        "h-8 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-subtle-foreground first:pl-4 last:pr-4",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

const CELL_TONE = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  warning: "text-warning",
  danger: "font-medium text-danger",
} as const;

/**
 * `tone` flags a value that crossed a threshold. The number itself stays the
 * information; tone is emphasis, so it never replaces the value.
 */
export function TableCell({
  className,
  numeric,
  mono,
  tone = "default",
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean; mono?: boolean; tone?: keyof typeof CELL_TONE }) {
  return (
    <td
      className={cn(
        "px-3 align-middle whitespace-nowrap first:pl-4 last:pr-4",
        CELL_TONE[tone],
        numeric && "text-right tabular-nums",
        mono && "font-mono text-xs",
        className,
      )}
      {...props}
    />
  );
}

/** Missing value: an em dash in tertiary ink, never "N/A", "null" or blank. */
export function Empty() {
  return <span className="text-subtle-foreground">—</span>;
}
