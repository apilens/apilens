"use client";

import { useState, useCallback } from "react";
import { registerPasskey, credentialToJSON, detectDeviceName } from "@/lib/webauthn";

interface UseAddPasskeyOptions {
  onSuccess?: () => void;
  /** Called when the device already had a passkey for this site. Not a real
   *  error — the credential exists, we just couldn't register a new one. */
  onAlreadyRegistered?: (message: string) => void;
  /** Called when the user cancelled the OS prompt. */
  onCancelled?: () => void;
  onError?: (message: string) => void;
}

/**
 * Shared passkey-registration hook used by both LoginMethodsSection (settings)
 * and the post-login PasskeyUpsellBanner. Wraps the options/register/verify
 * round-trip and surfaces friendly error messages.
 */
export function useAddPasskey({
  onSuccess,
  onAlreadyRegistered,
  onCancelled,
  onError,
}: UseAddPasskeyOptions = {}) {
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState("");

  const addPasskey = useCallback(
    async (deviceName?: string) => {
      setError("");
      setIsAdding(true);

      try {
        const optionsResponse = await fetch("/api/account/passkeys/register/options", {
          method: "POST",
        });
        if (!optionsResponse.ok) {
          const data = await optionsResponse.json().catch(() => ({}));
          throw new Error(data.error || "Failed to start passkey setup");
        }
        const options = await optionsResponse.json();
        const challenge = options.publicKey.challenge;

        const credential = await registerPasskey(options);
        const credentialJSON = credentialToJSON(credential);

        const verifyResponse = await fetch("/api/account/passkeys/register/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credential: credentialJSON,
            challenge,
            device_name: deviceName?.trim() || detectDeviceName(),
          }),
        });
        if (!verifyResponse.ok) {
          const data = await verifyResponse.json().catch(() => ({}));
          throw new Error(data.error || "Failed to verify passkey");
        }

        onSuccess?.();
      } catch (err: any) {
        const code = err?.code;
        const message = err?.message || "Failed to add passkey";

        if (code === "already_registered") {
          // The device already has a passkey for this site (likely synced via
          // iCloud Keychain / Google Password Manager). Treat as a soft success.
          onAlreadyRegistered?.(message);
        } else if (code === "cancelled") {
          onCancelled?.();
        } else {
          setError(message);
          onError?.(message);
        }
      } finally {
        setIsAdding(false);
      }
    },
    [onSuccess, onAlreadyRegistered, onCancelled, onError],
  );

  return { addPasskey, isAdding, error, clearError: () => setError("") };
}
