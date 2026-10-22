import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Badges carry state or a short attribute, never decoration. One badge per
// row at most. Status badges pair a dot with the word, never color alone.
const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 text-2xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        brand: "border-brand/25 bg-brand/10 text-brand-text",
        success: "border-success/25 bg-success/10 text-success",
        warning: "border-warning/25 bg-warning/10 text-warning",
        danger: "border-danger/25 bg-danger/10 text-danger",
        info: "border-info/25 bg-info/10 text-info",
      },
      mono: { true: "font-mono tracking-normal", false: "" },
    },
    defaultVariants: { tone: "neutral", mono: false },
  },
);

export interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  /** Leading status dot in the badge's own tone. */
  dot?: boolean;
}

export function Badge({ className, tone, mono, dot, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone, mono }), className)} {...props}>
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export { badgeVariants };
