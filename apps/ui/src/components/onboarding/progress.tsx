"use client";

// Saving onboarding progress on Continue (#327). `OnboardingProgress` (the onboarding layout)
// owns the error toast, so a failed save is still reported after the screen it came from has
// been left; `useOnboardingContinue` is what a screen's Continue calls.
import { unstable_rethrow, useRouter } from "next/navigation";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState, useTransition } from "react";
import { saveOnboarding } from "@/app/(auth)/onboarding/actions";
import type { OnboardingAnswers } from "@/lib/identity";
import { alreadyReached, stepToSave } from "@/lib/onboarding";
import { ObIcon } from "./ob";

/** How long the error toast stays up before it hides itself. */
const TOAST_MS = 8000;
const FAILED = "We couldn’t save your progress. Try again in a moment.";

/** What a save answers, as far as Continue cares. */
type Saved = { ok: true } | { ok: false; error: string };

const ToastContext =createContext<(message: string) => void>(() => {});

export function OnboardingProgress({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  // A new object per toast, so the same message twice restarts the timer.
  const [shown, setShown] = useState(0);
  const toast = useCallback((m: string) => {
    setMessage(m);
    setShown((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [message, shown]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Always rendered, so screen readers announce the message when it appears. */}
      <div className="ob-toasts" role="status" aria-live="polite">
        {message ? (
          <div className="ob-notice ob-notice--error ob-toast">
            <ObIcon name="info" />
            <p>{message}</p>
            <button type="button" className="ob-notice-x" aria-label="Dismiss" onClick={() => setMessage(null)}>
              <svg className="ob-ic" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

/** Shows a message in the onboarding error toast (for failures other than a save's). */
export function useOnboardingToast() {
  return useContext(ToastContext);
}

/**
 * Continue for an onboarding screen at step bar position `reached`: `go(step, href, answers)`
 * saves `step` (unless it is behind the progress already saved) and the answers, and opens
 * `href`. When the guard already lets the user onto `href` (an onboarding page at or before the
 * saved step) the browser goes there at once and the save follows; otherwise the guard would
 * send it back until the save lands, so it waits for the save. A failed save shows a toast; a
 * screen that waited stays where it is, so Continue can be pressed again. It runs as a
 * transition, so an expired session's redirect to sign-in reaches the router. `also` is another
 * save the screen needs with it (the home preference, #328); it runs alongside, and Continue
 * succeeds only when both do. `wait` always waits for the save, for a target page that reads the
 * answers being saved (the install step reads the instrument step's, #333).
 */
export function useOnboardingContinue(reached: number) {
  const router = useRouter();
  const toast = useContext(ToastContext);
  const [pending, startTransition] = useTransition();

  const go = useCallback(
    (step: string, href: string, answers: OnboardingAnswers = {}, also?: () => Promise<Saved>, wait = false) =>
      startTransition(async () => {
        const guard = (p: Promise<Saved>) =>
          p.catch((err: unknown): Saved => {
            unstable_rethrow(err);
            return { ok: false, error: FAILED };
          });
        const save = async (): Promise<Saved> => {
          const results = await Promise.all([guard(saveOnboarding(stepToSave(step, reached), answers)), ...(also ? [guard(also())] : [])]);
          return results.find((r) => !r.ok) ?? { ok: true };
        };
        if (!wait && href.startsWith("/onboarding/") && alreadyReached(step, reached)) {
          router.push(href);
          const result = await save();
          if (!result.ok) toast(result.error);
          return;
        }
        const result = await save();
        if (result.ok) startTransition(() => router.push(href));
        else toast(result.error);
      }),
    [reached, router, toast],
  );

  return { go, pending };
}
