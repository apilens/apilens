import { cn } from "@/lib/cn";

// Dense data table (Aperture): 36px rows, hairline row dividers, no zebra, no
// vertical rules. Numbers right-aligned in tabular figures; identifiers in mono.

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader(props: React.ComponentProps<"thead">) {
  return <thead className="[&_tr]:border-b [&_tr]:border-border [&_tr]:hover:bg-transparent" {...props} />;
}

export function TableBody(props: React.ComponentProps<"tbody">) {
  return <tbody className="[&_tr:last-child]:border-0" {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("h-9 border-b border-border transition-colors duration-100 hover:bg-muted/60", className)} {...props} />;
}

export function TableHead({ className, numeric, ...props }: React.ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
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

export type CellTone = keyof typeof CELL_TONE;

/** `tone` flags a value that crossed a threshold; the value stays the information. */
export function TableCell({
  className,
  numeric,
  mono,
  tone = "default",
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean; mono?: boolean; tone?: CellTone }) {
  return (
    <td
      className={cn(
        "px-3 py-1.5 align-middle whitespace-nowrap first:pl-4 last:pr-4",
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
