"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface FetchOptions<T> {
  /** Async function that produces the data. Must throw on failure. */
  fetcher: () => Promise<T>;
  /** Run the fetcher on mount. Default true. */
  enabled?: boolean;
  /** Initial data (before first fetch). Default null. */
  initialData?: T | null;
  /** Auto-retry on error. Set 0 to disable. Default 0. */
  retryCount?: number;
  /** Base delay between retries in ms. Doubles each attempt. Default 1000. */
  retryDelayMs?: number;
  /** Dependencies — when they change, refetch from scratch. */
  deps?: unknown[];
}

interface FetchResult<T> {
  data: T | null;
  isLoading: boolean;
  /** Error from the most recent attempt, after retries are exhausted. */
  error: Error | null;
  /** Currently retrying after a failure (NOT the initial load). */
  isRetrying: boolean;
  /** Refetch from scratch — resets retry counter. */
  retry: () => Promise<void>;
  /** Imperatively replace the cached data (e.g., after a mutation). */
  setData: (next: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * Data-fetching hook with auto-retry + exponential backoff. Designed for the
 * "load on mount, retry on transient failure" pattern that every settings
 * section needs. Cancels in-flight requests when deps change.
 *
 * Returns a `retry()` function for explicit user-driven refetches (powering
 * the "Try again" button on SectionError).
 */
export function useFetchWithRetry<T>({
  fetcher,
  enabled = true,
  initialData = null,
  retryCount = 0,
  retryDelayMs = 1000,
  deps = [],
}: FetchOptions<T>): FetchResult<T> {
  const [data, setData] = useState<T | null>(initialData);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Tracks the active fetch generation. A new fetch invalidates older ones so
  // a stale slow response can't overwrite fresh data.
  const generationRef = useRef(0);
  // Keep the fetcher current in a ref so the load() effect doesn't recreate.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(
    async (isExplicitRetry: boolean) => {
      const gen = ++generationRef.current;
      if (isExplicitRetry) {
        setIsRetrying(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      let attempt = 0;
      // Retry loop — runs initial + retryCount additional attempts.
      while (true) {
        try {
          const next = await fetcherRef.current();
          if (gen !== generationRef.current) return; // a newer fetch superseded us
          setData(next);
          setIsLoading(false);
          setIsRetrying(false);
          return;
        } catch (err) {
          if (gen !== generationRef.current) return;
          attempt += 1;
          if (attempt > retryCount) {
            setError(err instanceof Error ? err : new Error(String(err)));
            setIsLoading(false);
            setIsRetrying(false);
            return;
          }
          // Exponential backoff with mild jitter
          const delay = retryDelayMs * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    },
    [retryCount, retryDelayMs],
  );

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void load(false);
    // We DO want to refetch when deps change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  const retry = useCallback(async () => {
    await load(true);
  }, [load]);

  const setDataExposed = useCallback<FetchResult<T>["setData"]>((next) => {
    setData((prev) => (typeof next === "function" ? (next as (p: T | null) => T | null)(prev) : next));
  }, []);

  return { data, isLoading, isRetrying, error, retry, setData: setDataExposed };
}
