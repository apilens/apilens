import * as React from "react";

import { cn } from "@/lib/utils";

/** `mono` for identifiers people copy or compare: keys, slugs, paths, ids. */
export function Input({ className, type = "text", mono = false, ...props }: React.ComponentProps<"input"> & { mono?: boolean }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-field px-2.5 text-sm text-foreground shadow-panel",
        "placeholder:text-subtle-foreground",
        "transition duration-100 ease-out outline-none",
        "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-ring",
        "aria-invalid:border-danger aria-invalid:ring-danger/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "read-only:bg-muted read-only:text-muted-foreground read-only:focus-visible:border-input read-only:focus-visible:ring-0",
        "file:me-2 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        mono && "font-mono text-xs",
        className,
      )}
      {...props}
    />
  );
}
