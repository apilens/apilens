"use client";

import { useCallback, useRef, useState } from "react";

interface UseAsyncActionOptions<TArgs extends unknown[], TResult> {
  /** Called on success with the returned value. */
  onSuccess?: (result: TResult, args: TArgs) => void;
  /** Called on failure with the error. If omitted, the error is just stored. */
  onError?: (error: Error, args: TArgs) => void;
}

interface UseAsyncActionResult<TArgs extends unknown[], TResult> {
  run: (...args: TArgs) => Promise<TResult | undefined>;
  isRunning: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * Wrap a one-shot async action (save profile, revoke session, etc.) with:
 *   - in-flight guard to prevent double-submission on rapid clicks
 *   - canonical isRunning / error state
 *   - onSuccess / onError callbacks
 *
 * The returned `run` swallows errors by default (they go to `error` state
 * and the onError callback) — call sites don't need a try/catch.
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncActionOptions<TArgs, TResult> = {},
): UseAsyncActionResult<TArgs, TResult> {
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Guards against double-firing while a previous call is still in flight.
  const inFlightRef = useRef(false);

  // Keep callbacks current without re-creating `run` on every render.
  const actionRef = useRef(action);
  actionRef.current = action;
  const onSuccessRef = useRef(options.onSuccess);
  onSuccessRef.current = options.onSuccess;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      if (inFlightRef.current) return undefined;
      inFlightRef.current = true;
      setIsRunning(true);
      setError(null);

      try {
        const result = await actionRef.current(...args);
        onSuccessRef.current?.(result, args);
        return result;
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        onErrorRef.current?.(wrapped, args);
        return undefined;
      } finally {
        setIsRunning(false);
        inFlightRef.current = false;
      }
    },
    [],
  );

  const reset = useCallback(() => setError(null), []);

  return { run, isRunning, error, reset };
}
