"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CaretDownIcon, ClockIcon } from "@/components/ui/icon";

export const RANGES = [
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

export type Range = (typeof RANGES)[number]["value"];

/**
 * One global time range per page, top-right of the page header. In the real
 * app the value lives in the URL (?range=24h) so views are shareable; this
 * demo keeps it in state.
 */
export function TimeRangePicker({ defaultValue = "24h", timeZone = "UTC" }: { defaultValue?: Range; timeZone?: string }) {
  const [value, setValue] = React.useState<Range>(defaultValue);
  const label = RANGES.find((r) => r.value === value)?.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="md">
          <ClockIcon />
          {label}
          <CaretDownIcon className="text-subtle-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => setValue(v as Range)}>
          {RANGES.map((r) => (
            <DropdownMenuRadioItem key={r.value} value={r.value}>
              {r.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Times shown in {timeZone}</DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
