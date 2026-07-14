"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, Check } from "lucide-react";
import SettingsCard from "./SettingsCard";
import { cn } from "@/lib/utils";
import { Input } from "@/components/reui/input";

interface TimezoneSectionProps {
  timezone: string;
  onUpdateTimezone: (timezone: string) => Promise<void>;
}

/**
 * Common-name aliases users actually type ("EST" → America/New_York etc.).
 * The IANA database doesn't include these as canonical zones anymore, so we
 * map them ourselves for search.
 */
const TZ_ALIASES: Record<string, string[]> = {
  "America/New_York": ["EST", "EDT", "Eastern"],
  "America/Chicago": ["CST", "CDT", "Central"],
  "America/Denver": ["MST", "MDT", "Mountain"],
  "America/Los_Angeles": ["PST", "PDT", "Pacific"],
  "Europe/London": ["BST", "GMT"],
  "Europe/Berlin": ["CET", "CEST"],
  "Asia/Kolkata": ["IST", "India"],
  "Asia/Singapore": ["SGT"],
  "Asia/Tokyo": ["JST"],
  "Australia/Sydney": ["AEST", "AEDT"],
};

function formatOffset(tz: string): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const part = dtf.formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

function formatLocalTime(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date());
  } catch {
    return "";
  }
}

export default function TimezoneSection({ timezone, onUpdateTimezone }: TimezoneSectionProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Tick every minute so the "currently 3:42 PM in this zone" hint stays fresh.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);

  const timezoneOptions = useMemo(() => {
    const common = Object.keys(TZ_ALIASES);
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const set = new Set<string>([...common, "UTC"]);
    if (browserTz) set.add(browserTz);
    const withIntl = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof withIntl === "function") {
      for (const tz of withIntl("timeZone")) set.add(tz);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, []);

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return timezoneOptions;
    return timezoneOptions.filter((tz) => {
      if (tz.toLowerCase().includes(q)) return true;
      // Also match against common-name aliases ("EST" finds America/New_York).
      const aliases = TZ_ALIASES[tz];
      return aliases?.some((a) => a.toLowerCase().includes(q)) ?? false;
    });
  }, [search, timezoneOptions]);

  const handleTimezoneChange = async (nextTimezone: string) => {
    if (!nextTimezone || nextTimezone === timezone) return;
    setIsSaving(true);
    try {
      await onUpdateTimezone(nextTimezone);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const offsetLabel = formatOffset(timezone);
  const localTimeLabel = formatLocalTime(timezone);

  return (
    <SettingsCard
      title="Timezone"
      description="Affects how dates and times appear across the app"
    >
      <div className="flex items-center gap-3">
        <span className="w-23 shrink-0 text-[13px] font-medium text-muted-foreground">
          Timezone
        </span>
        <div className="relative min-w-0 flex-1" ref={containerRef}>
          <button
            type="button"
            className={cn(
              "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-[13px] text-foreground shadow-xs transition-[color,box-shadow] outline-none",
              "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
            )}
            onClick={() => setOpen((prev) => !prev)}
            disabled={isSaving}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="truncate">{timezone}</span>
              {offsetLabel && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{offsetLabel}</span>
              )}
            </span>
            <span className="shrink-0 text-muted-foreground" aria-hidden="true">
              {isSaving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : justSaved ? (
                <Check size={14} className="text-success" />
              ) : (
                <ChevronDown size={14} />
              )}
            </span>
          </button>
          {open && (
            <div
              className="absolute left-0 right-0 top-full z-50 mt-1 flex max-h-72 flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
              role="listbox"
            >
              <div className="border-b border-border p-2">
                <Input
                  type="text"
                  className="h-8 text-[13px]"
                  placeholder="Search by city, region, or abbreviation (EST, IST, …)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="flex-1 overflow-y-auto p-1">
                {filteredOptions.length === 0 ? (
                  <p className="px-3 py-2 text-[13px] text-muted-foreground">
                    No matching timezones
                  </p>
                ) : (
                  filteredOptions.map((tz) => {
                    const offset = formatOffset(tz);
                    const isCurrent = tz === timezone;
                    return (
                      <button
                        key={tz}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-[13px] text-foreground outline-none transition-colors",
                          "hover:bg-accent focus-visible:bg-accent",
                          isCurrent && "bg-primary/10 font-medium text-primary",
                        )}
                        onClick={async () => {
                          await handleTimezoneChange(tz);
                          setOpen(false);
                          setSearch("");
                        }}
                      >
                        <span className="min-w-0 truncate">{tz}</span>
                        {offset && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {offset}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {localTimeLabel && (
        <p className="mt-2 pl-26 text-xs text-muted-foreground" aria-live="polite">
          It's currently{" "}
          <strong className="font-semibold text-foreground">{localTimeLabel}</strong> in this
          timezone.
        </p>
      )}
    </SettingsCard>
  );
}
