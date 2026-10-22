import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// System-level state that changes what the user is allowed to trust or do:
// support access, read-only mode, degraded ingestion. Full width, above the
// top bar, never dismissible while the state is true. Not for marketing.
const bannerVariants = cva("flex min-h-8 items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium [&_svg]:size-3.5", {
  variants: {
    tone: {
      info: "bg-info/12 text-info",
      warning: "bg-warning/12 text-warning",
      danger: "bg-danger/12 text-danger",
    },
  },
  defaultVariants: { tone: "info" },
});

export function Banner({
  tone,
  icon,
  children,
  action,
}: VariantProps<typeof bannerVariants> & { icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div role="status" className={cn(bannerVariants({ tone }))}>
      {icon}
      <span>{children}</span>
      {action}
    </div>
  );
}
