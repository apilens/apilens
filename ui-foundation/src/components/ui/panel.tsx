import * as React from "react";

import { cn } from "@/lib/utils";

// Panel is the only container surface. No nested panels, no "card grids" of
// identical marketing tiles: a panel holds one table, one chart, or one form.

export function Panel({ className, tone = "default", ...props }: React.ComponentProps<"section"> & { tone?: "default" | "danger" }) {
  return (
    <section
      data-slot="panel"
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-panel",
        tone === "danger" ? "border-danger/30" : "border-border",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header data-slot="panel-header" className={cn("flex min-h-12 items-center gap-3 border-b border-border px-4 py-2.5", className)}>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="truncate text-xs text-subtle-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="panel-body" className={cn("p-4", className)} {...props} />;
}

export function PanelFooter({ className, ...props }: React.ComponentProps<"footer">) {
  return (
    <footer
      data-slot="panel-footer"
      className={cn("flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-4 py-2.5", className)}
      {...props}
    />
  );
}
