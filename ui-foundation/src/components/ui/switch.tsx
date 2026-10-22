"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "focus-ring peer inline-flex h-4.5 w-8 shrink-0 items-center rounded-full bg-accent shadow-control transition-colors duration-150",
        "data-[state=checked]:bg-brand disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-foreground shadow-control transition-transform duration-150 data-[state=checked]:translate-x-4 data-[state=checked]:bg-brand-foreground" />
    </SwitchPrimitive.Root>
  );
}
