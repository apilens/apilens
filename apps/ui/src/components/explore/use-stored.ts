"use client";

import { useCallback, useEffect, useState } from "react";

/** Reads a remembered value; private windows and blocked storage read as nothing. */
export function readStored<T>(key: string, check: (v: unknown) => v is T): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    return check(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, v: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Storage full or blocked: the choice lasts for this visit only.
  }
}

/**
 * A per-viewer preference remembered in this browser (#1052: the facet sidebar, the columns): the
 * server render and the first paint use `initial`, then the remembered value once mounted.
 */
export function useStored<T>(key: string, initial: T, check: (v: unknown) => v is T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const v = readStored(key, check);
    if (v !== null) setValue(v);
    // Read once per key.
  }, [key]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writeStored(key, v);
        return v;
      }),
    [key],
  );
  return [value, set];
}

export const isBool = (v: unknown): v is boolean => typeof v === "boolean";
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
