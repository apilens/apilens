"use client";

// Hands the user's time zone (#1046) to Client Components. `AppShell` mounts it from the user
// context; outside it (sign-in, onboarding before a context exists) `useTimeZone` answers UTC.
import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_TIME_ZONE } from "./time-zone";

const TimeZoneContext = createContext<string>(DEFAULT_TIME_ZONE);

export function TimeZoneProvider({ timeZone, children }: { timeZone: string; children?: ReactNode }) {
  return <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>;
}

/** The zone to format times in. */
export function useTimeZone(): string {
  return useContext(TimeZoneContext);
}
