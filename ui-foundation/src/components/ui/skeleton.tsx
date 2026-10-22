import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Loading placeholder shaped like the content it replaces. Match the real
 * row height and column widths so nothing jumps when data lands.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden data-slot="skeleton" className={cn("animate-skeleton rounded-sm bg-accent", className)} {...props} />;
}
