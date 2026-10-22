import { cn } from "@/lib/cn";

// Panel is the only container surface (Aperture). One panel holds one table,
// chart or form. No nested panels, no grids of identical tiles.

export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("rounded-lg border border-border bg-card text-card-foreground shadow-panel", className)} {...props} />;
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex min-h-12 items-center gap-3 border-b border-border px-4 py-2.5", className)}>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="truncate text-xs text-subtle-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}
