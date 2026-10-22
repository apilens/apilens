"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

const SIZE = {
  default: "w-72",
  /** Two-pane pickers (scope switcher). Never wider than the space Radix measures. */
  wide: "w-xl max-w-(--radix-popover-content-available-width)",
} as const;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  size = "default",
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { size?: keyof typeof SIZE }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-overlay outline-none",
          SIZE[size],
          "data-[state=closed]:animate-overlay-out data-[state=open]:animate-overlay-in",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
