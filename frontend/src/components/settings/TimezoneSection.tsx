"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import SettingsCard from "./SettingsCard";

interface TimezoneSectionProps {
  timezone: string;
  onUpdateTimezone: (timezone: string) => Promise<void>;
}

export default function TimezoneSection({ timezone, onUpdateTimezone }: TimezoneSectionProps) {
  const [isSavingTimezone, setIsSavingTimezone] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const timezoneOptions = useMemo(() => {
    const common = [
      "UTC",
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "Europe/London",
      "Europe/Berlin",
      "Asia/Kolkata",
      "Asia/Singapore",
      "Asia/Tokyo",
      "Australia/Sydney",
    ];
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const set = new Set<string>(common);
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
    return timezoneOptions.filter((tz) => tz.toLowerCase().includes(q));
  }, [search, timezoneOptions]);

  const handleTimezoneChange = async (nextTimezone: string) => {
    if (!nextTimezone || nextTimezone === timezone) return;
    setIsSavingTimezone(true);
    try {
      await onUpdateTimezone(nextTimezone);
    } finally {
      setIsSavingTimezone(false);
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

  return (
    <SettingsCard
      title="Timezone"
      description="Control how date and time values are shown"
    >
      <div className="profile-timezone-row">
        <span className="profile-timezone-label">Current timezone</span>
        <div className="timezone-combobox" ref={containerRef}>
          <button
            type="button"
            className="profile-timezone-select timezone-trigger"
            onClick={() => setOpen((prev) => !prev)}
            disabled={isSavingTimezone}
          >
            <span className="timezone-trigger-value">{timezone}</span>
            <span className="timezone-trigger-icon">▾</span>
          </button>
          {open && (
            <div className="timezone-dropdown">
              <input
                type="text"
                className="timezone-search-input"
                placeholder="Search timezone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              <div className="timezone-options">
                {filteredOptions.length === 0 ? (
                  <p className="timezone-empty">No timezone found</p>
                ) : (
                  filteredOptions.map((tz) => (
                    <button
                      key={tz}
                      type="button"
                      className={`timezone-option${tz === timezone ? " active" : ""}`}
                      onClick={async () => {
                        await handleTimezoneChange(tz);
                        setOpen(false);
                        setSearch("");
                      }}
                    >
                      {tz}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsCard>
  );
}
