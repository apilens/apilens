"use client";

import { useEffect, useState } from "react";
import { Fingerprint, X, Loader2, Check } from "lucide-react";
import { isPasskeySupported, getBiometricLabel } from "@/lib/webauthn";
import { useAddPasskey } from "@/hooks/useAddPasskey";
import { Button } from "@/components/reui/button";

const DISMISSED_KEY = "apilens.passkey_upsell_dismissed_until";
const HAS_PASSKEY_KEY = "apilens.has_passkey_ever";
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Non-blocking dashboard banner inviting the user to set up a passkey
 * (Face ID / Touch ID / Windows Hello) for faster future sign-ins.
 *
 * Visibility rules — all must be true:
 *   1. Browser supports WebAuthn + platform authenticator.
 *   2. User has zero passkeys on file (checked via /api/account/passkeys).
 *   3. localStorage dismissal flag is missing or expired.
 *
 * On successful registration: hides forever (HAS_PASSKEY_KEY set).
 * On "Not now": hides for 30 days.
 */
export default function PasskeyUpsellBanner() {
  const [visible, setVisible] = useState(false);
  const [registered, setRegistered] = useState(false);

  const markHasPasskey = () => {
    try {
      localStorage.setItem(HAS_PASSKEY_KEY, "1");
      localStorage.removeItem(DISMISSED_KEY);
    } catch {
      // localStorage may be blocked in private mode — that's fine.
    }
  };

  const { addPasskey, isAdding, error } = useAddPasskey({
    onSuccess: () => {
      markHasPasskey();
      setRegistered(true);
      setTimeout(() => setVisible(false), 2200);
    },
    onAlreadyRegistered: () => {
      // Device already has a passkey for this site (probably synced).
      // Don't keep nagging — flag as set up and dismiss.
      markHasPasskey();
      setVisible(false);
    },
    onCancelled: () => {
      // User dismissed the OS prompt. Don't show an error — just leave the
      // banner up so they can try again later.
    },
  });

  useEffect(() => {
    let cancelled = false;

    const decide = async () => {
      // 1. Supported?
      if (!(await isPasskeySupported())) return;

      // 2. Already has a passkey (either set locally or on server)?
      try {
        if (localStorage.getItem(HAS_PASSKEY_KEY) === "1") return;
        const dismissedUntil = parseInt(localStorage.getItem(DISMISSED_KEY) || "0", 10);
        if (dismissedUntil > Date.now()) return;
      } catch {
        // localStorage blocked — proceed cautiously, treat as not-dismissed.
      }

      // 3. Confirm with the server they have no passkeys yet.
      try {
        const res = await fetch("/api/account/passkeys");
        if (!res.ok) return;
        const data = await res.json();
        const list = data.passkeys || [];
        if (list.length > 0) {
          // Server already has passkeys — set the local flag so we never
          // even probe again on this device.
          try { localStorage.setItem(HAS_PASSKEY_KEY, "1"); } catch {}
          return;
        }
      } catch {
        return; // network blip — just don't show
      }

      if (!cancelled) setVisible(true);
    };

    void decide();
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now() + DISMISS_DURATION_MS));
    } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  const biometric = getBiometricLabel();

  return (
    <div
      role="region"
      aria-label="Set up passkey"
      className="mb-5 flex items-center gap-4 rounded-xl bg-invert px-5 py-4 text-invert-foreground shadow-sm"
    >
      <div className="flex shrink-0 items-center justify-center rounded-lg bg-invert-foreground/10 p-2.5">
        <Fingerprint size={22} strokeWidth={1.7} />
      </div>

      <div className="min-w-0 flex-1">
        {registered ? (
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Check size={14} />
            Passkey added. You can sign in with {biometric} next time.
          </p>
        ) : (
          <>
            <p className="text-sm leading-snug font-semibold">
              Sign in faster next time with {biometric}
            </p>
            <p className="mt-0.5 text-xs leading-snug text-invert-foreground/70">
              No password needed. Uses your device's built-in biometrics.
              {error && <span className="mt-1 block text-destructive">{error}</span>}
            </p>
          </>
        )}
      </div>

      {!registered && (
        <>
          <Button
            type="button"
            size="sm"
            onClick={() => void addPasskey()}
            disabled={isAdding}
            className="shrink-0 bg-invert-foreground text-invert hover:bg-invert-foreground/90"
          >
            {isAdding ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Setting up…
              </>
            ) : (
              <>Set up {biometric}</>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={dismiss}
            disabled={isAdding}
            aria-label="Dismiss"
            className="shrink-0 text-invert-foreground/60 hover:bg-invert-foreground/10 hover:text-invert-foreground"
          >
            <X size={16} />
          </Button>
        </>
      )}
    </div>
  );
}
