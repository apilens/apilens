"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Separator } from "@/components/reui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/reui/popover";

/* Shared time-range picker used by Traffic, Request logs, etc.
   A range is either a named preset (rolling window or calendar-aligned) or a
   user-defined custom window. `resolveRange` turns either into a concrete
   { since, until } pair plus the span (used for bucket labelling + RPM). */

export type RangeValue =
  | { type: "preset"; id: string }
  | { type: "custom"; since: string; until: string };

export interface ResolvedRange {
  since: string;
  until: string;
  spanHours: number;
  label: string;
}

// Rolling windows ending "now".
export const ROLLING_PRESETS = [
  { id: "1h", label: "Last hour", hours: 1 },
  { id: "6h", label: "Last 6 hours", hours: 6 },
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 168 },
  { id: "30d", label: "Last 30 days", hours: 720 },
  { id: "90d", label: "Last 90 days", hours: 2160 },
] as const;

// Calendar-aligned windows (local time).
export const CALENDAR_PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "this_month", label: "This month" },
] as const;

export const DEFAULT_PRESET_ID = "24h";
export const DEFAULT_RANGE: RangeValue = { type: "preset", id: DEFAULT_PRESET_ID };

// Reconstruct the range from URL params: custom (since+until) wins, else a known
// preset id, else the default.
export function parseRange(f?: { range?: string; since?: string; until?: string }): RangeValue {
  if (f?.since && f?.until) return { type: "custom", since: f.since, until: f.until };
  if (f?.range) {
    const known = [...ROLLING_PRESETS, ...CALENDAR_PRESETS].some((p) => p.id === f.range);
    if (known) return { type: "preset", id: f.range };
  }
  return DEFAULT_RANGE;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function resolveRange(value: RangeValue): ResolvedRange {
  const now = new Date();
  const spanOf = (since: Date, until: Date) =>
    Math.max(1 / 60, (until.getTime() - since.getTime()) / 3_600_000);

  if (value.type === "custom") {
    const since = new Date(value.since);
    const until = new Date(value.until);
    return {
      since: since.toISOString(),
      until: until.toISOString(),
      spanHours: spanOf(since, until),
      label: customLabel(since, until),
    };
  }

  const rolling = ROLLING_PRESETS.find((p) => p.id === value.id);
  if (rolling) {
    const since = new Date(now.getTime() - rolling.hours * 3_600_000);
    return { since: since.toISOString(), until: now.toISOString(), spanHours: rolling.hours, label: rolling.label };
  }

  // Calendar presets.
  let since: Date;
  let until = now;
  switch (value.id) {
    case "yesterday": {
      const todayStart = startOfDay(now);
      since = new Date(todayStart.getTime() - 86_400_000);
      until = todayStart;
      break;
    }
    case "this_week": {
      const s = startOfDay(now);
      const dow = (s.getDay() + 6) % 7; // Monday = 0
      since = new Date(s.getTime() - dow * 86_400_000);
      break;
    }
    case "this_month":
      since = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "today":
    default:
      since = startOfDay(now);
      break;
  }
  const label = CALENDAR_PRESETS.find((p) => p.id === value.id)?.label ?? "Today";
  return { since: since.toISOString(), until: until.toISOString(), spanHours: spanOf(since, until), label };
}

function customLabel(since: Date, until: Date): string {
  const sameDay = since.toDateString() === until.toDateString();
  const d = (x: Date) => x.toLocaleDateString([], { month: "short", day: "numeric" });
  const t = (x: Date) => x.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `${d(since)}, ${t(since)} – ${t(until)}` : `${d(since)} – ${d(until)}`;
}

// ISO ⇄ <input type="datetime-local"> value (which is local, no timezone).
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

export function TimeRangePicker({
  value,
  resolved,
  onChange,
}: {
  value: RangeValue;
  resolved: ResolvedRange;
  onChange: (v: RangeValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(() => toLocalInput(resolved.since));
  const [to, setTo] = useState(() => toLocalInput(resolved.until));
  const [error, setError] = useState("");

  // Seed the custom inputs from the live window each time the menu opens.
  useEffect(() => {
    if (open) {
      setFrom(toLocalInput(resolved.since));
      setTo(toLocalInput(resolved.until));
      setError("");
    }
  }, [open, resolved.since, resolved.until]);

  const isPreset = (id: string) => value.type === "preset" && value.id === id;

  const pickPreset = (id: string) => {
    onChange({ type: "preset", id });
    setOpen(false);
  };

  const applyCustom = () => {
    if (!from || !to) {
      setError("Pick a start and end time.");
      return;
    }
    const sinceMs = new Date(from).getTime();
    const untilMs = new Date(to).getTime();
    if (isNaN(sinceMs) || isNaN(untilMs)) {
      setError("Invalid date.");
      return;
    }
    if (sinceMs >= untilMs) {
      setError("Start must be before end.");
      return;
    }
    onChange({ type: "custom", since: fromLocalInput(from), until: fromLocalInput(to) });
    setOpen(false);
  };

  const presetButton = (p: { id: string; label: string }) => (
    <button
      key={p.id}
      type="button"
      className={cn(
        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        isPreset(p.id) && "font-semibold text-primary hover:text-primary",
      )}
      onClick={() => pickPreset(p.id)}
    >
      <span>{p.label}</span>
      {isPreset(p.id) && <Check size={13} className="text-primary" />}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-[30px] gap-1.5 rounded-lg px-2.5 text-xs font-medium data-[state=open]:border-primary"
        >
          <span className="whitespace-nowrap">{resolved.label}</span>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        aria-label="Select time range"
        className="flex w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-hidden p-0 sm:flex-row"
      >
        <div className="shrink-0 border-b border-border p-2 sm:w-[190px] sm:border-b-0 sm:border-r">
          <p className="mx-1 mb-1.5 mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Quick ranges
          </p>
          {ROLLING_PRESETS.map(presetButton)}
          <Separator className="my-1.5" />
          <p className="mx-1 mb-1.5 mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Calendar
          </p>
          {CALENDAR_PRESETS.map(presetButton)}
        </div>

        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className="mx-1 mb-0.5 mt-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Custom range
            {value.type === "custom" && (
              <Badge variant="primary-light" size="sm" radius="full" className="normal-case tracking-normal">
                Active
              </Badge>
            )}
          </p>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <span>From</span>
            <Input
              type="datetime-local"
              className="h-8 rounded-lg px-2 text-xs dark:[color-scheme:dark]"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <span>To</span>
            <Input
              type="datetime-local"
              className="h-8 rounded-lg px-2 text-xs dark:[color-scheme:dark]"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {error && <p className="m-0 text-[11px] text-destructive">{error}</p>}
          <Button size="sm" className="mt-auto h-8 text-xs font-semibold" onClick={applyCustom}>
            Apply custom range
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
