import * as React from "react";

import { cn } from "@/lib/utils";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-card px-1 font-mono text-2xs text-muted-foreground shadow-control",
        className,
      )}
      {...props}
    />
  );
}
