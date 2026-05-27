"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, Check } from "lucide-react";
import SettingsCard from "./SettingsCard";

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
      <div className="profile-timezone-row">
        <span className="profile-timezone-label">Timezone</span>
        <div className="timezone-combobox" ref={containerRef}>
          <button
            type="button"
            className="profile-timezone-select timezone-trigger"
            onClick={() => setOpen((prev) => !prev)}
            disabled={isSaving}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span className="timezone-trigger-value" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              {timezone}
              {offsetLabel && (
                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{offsetLabel}</span>
              )}
            </span>
            <span className="timezone-trigger-icon" aria-hidden="true">
              {isSaving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : justSaved ? (
                <Check size={14} style={{ color: "var(--success, #16a34a)" }} />
              ) : (
                <ChevronDown size={14} />
              )}
            </span>
          </button>
          {open && (
            <div className="timezone-dropdown" role="listbox">
              <input
                type="text"
                className="timezone-search-input"
                placeholder="Search by city, region, or abbreviation (EST, IST, …)"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              <div className="timezone-options">
                {filteredOptions.length === 0 ? (
                  <p className="timezone-empty">No matching timezones</p>
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
                        className={`timezone-option${isCurrent ? " active" : ""}`}
                        onClick={async () => {
                          await handleTimezoneChange(tz);
                          setOpen(false);
                          setSearch("");
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "12px",
                        }}
                      >
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {tz}
                        </span>
                        {offset && (
                          <span style={{ fontSize: "11px", color: "var(--text-muted)", flexShrink: 0 }}>
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
        <p
          style={{
            marginTop: "8px",
            fontSize: "12px",
            color: "var(--text-muted)",
            paddingLeft: "104px",  // align under the input (92px label col + 12px gap)
          }}
          aria-live="polite"
        >
          It's currently <strong style={{ color: "var(--text-secondary)" }}>{localTimeLabel}</strong> in this timezone.
        </p>
      )}
    </SettingsCard>
  );
}
