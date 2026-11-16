"use client";

import { type ReactNode, createContext, useContext, useMemo } from "react";
import type { NamedApp } from "@/lib/identity";

/**
 * The project's app names by id (#975), for the request log's App column, the App filter's chip
 * and the request drawer's Overview. Empty when the apps could not be read.
 */
const AppNames = createContext<ReadonlyMap<string, string>>(new Map());

/** Names the apps of `apps` for everything under it. */
export function AppNamesProvider({ apps, children }: { apps: readonly NamedApp[] | null; children: ReactNode }) {
  const names = useMemo(() => new Map((apps ?? []).map((a) => [a.id.toLowerCase(), a.name])), [apps]);
  return <AppNames.Provider value={names}>{children}</AppNames.Provider>;
}

/** A lookup of app names by id (null for an app the project's apps do not list). */
export function useAppNames(): (id: string) => string | null {
  const names = useContext(AppNames);
  return (id) => names.get(id.toLowerCase()) ?? null;
}

/** The name of app `id`, or null when the project's apps do not list it (or no id). */
export function useAppName(id: string | undefined): string | null {
  const names = useContext(AppNames);
  return id ? (names.get(id.toLowerCase()) ?? null) : null;
}
