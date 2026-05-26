"use client";

import { useEffect, useState } from "react";
import { Fingerprint, X, Loader2, Check } from "lucide-react";
import { isPasskeySupported, getBiometricLabel } from "@/lib/webauthn";
import { useAddPasskey } from "@/hooks/useAddPasskey";

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
      style={{
        margin: "0 0 20px 0",
        padding: "16px 20px",
        background: "linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%)",
        color: "#fff",
        borderRadius: "10px",
        display: "flex",
        alignItems: "center",
        gap: "16px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
      }}
    >
      <div
        style={{
          background: "rgba(255,255,255,0.1)",
          padding: "10px",
          borderRadius: "8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Fingerprint size={22} strokeWidth={1.7} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {registered ? (
          <>
            <p style={{ margin: 0, fontWeight: 600, fontSize: "14px" }}>
              <Check size={14} style={{ verticalAlign: "-2px", marginRight: "6px" }} />
              Passkey added. You can sign in with {biometric} next time.
            </p>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontWeight: 600, fontSize: "14px", lineHeight: 1.4 }}>
              Sign in faster next time with {biometric}
            </p>
            <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", opacity: 0.7, lineHeight: 1.4 }}>
              No password needed. Uses your device's built-in biometrics.
              {error && <span style={{ color: "#fca5a5", display: "block", marginTop: "4px" }}>{error}</span>}
            </p>
          </>
        )}
      </div>

      {!registered && (
        <>
          <button
            type="button"
            onClick={() => void addPasskey()}
            disabled={isAdding}
            style={{
              background: "#fff",
              color: "#1a1a1a",
              border: "none",
              padding: "8px 14px",
              borderRadius: "6px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: isAdding ? "default" : "pointer",
              opacity: isAdding ? 0.7 : 1,
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flexShrink: 0,
            }}
          >
            {isAdding ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Setting up…
              </>
            ) : (
              <>Set up {biometric}</>
            )}
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={isAdding}
            aria-label="Dismiss"
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.6)",
              cursor: "pointer",
              padding: "4px",
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        </>
      )}
    </div>
  );
}
