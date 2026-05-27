/**
 * WebAuthn / Passkey utilities for client-side credential management
 */

// Helper functions for base64url encoding/decoding
export function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Check if WebAuthn is supported in the current browser
 */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.PublicKeyCredential !== undefined &&
    typeof window.PublicKeyCredential === 'function'
  );
}

/**
 * Check if the device supports passkeys (platform authenticators)
 */
export async function isPasskeySupported(): Promise<boolean> {
  if (!isWebAuthnSupported()) {
    return false;
  }

  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    return available;
  } catch {
    return false;
  }
}

/**
 * Register a new passkey credential
 */
export async function registerPasskey(
  options: any
): Promise<PublicKeyCredential> {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }

  // Convert base64url strings to ArrayBuffers
  const publicKey = {
    ...options.publicKey,
    challenge: base64urlToBuffer(options.publicKey.challenge),
    user: {
      ...options.publicKey.user,
      id: base64urlToBuffer(options.publicKey.user.id),
    },
    excludeCredentials: options.publicKey.excludeCredentials?.map((cred: any) => ({
      ...cred,
      id: base64urlToBuffer(cred.id),
    })),
  };

  try {
    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) {
      throw new Error('Failed to create credential');
    }
    return credential as PublicKeyCredential;
  } catch (error: any) {
    // Tag this for callers — we treat "already-registered" as a non-error.
    if (error?.name === 'InvalidStateError') {
      const e = new Error("You already have a passkey for API Lens on this device. You can sign in with it from the login page.");
      (e as any).code = "already_registered";
      throw e;
    }
    if (error?.name === 'NotAllowedError') {
      const e = new Error('Passkey setup was cancelled.');
      (e as any).code = "cancelled";
      throw e;
    }
    if (error?.name === 'NotSupportedError') {
      throw new Error('Passkeys are not supported on this device.');
    }
    console.error('Passkey registration error:', error);
    throw new Error(error?.message || 'Failed to register passkey');
  }
}

/**
 * Authenticate with an existing passkey
 */
export async function authenticatePasskey(
  options: any
): Promise<PublicKeyCredential> {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }

  // Convert base64url strings to ArrayBuffers
  const publicKey = {
    ...options.publicKey,
    challenge: base64urlToBuffer(options.publicKey.challenge),
    allowCredentials: options.publicKey.allowCredentials?.map((cred: any) => ({
      ...cred,
      id: base64urlToBuffer(cred.id),
    })),
  };

  try {
    const credential = await navigator.credentials.get({ publicKey });
    if (!credential) {
      throw new Error('Failed to get credential');
    }
    return credential as PublicKeyCredential;
  } catch (error: any) {
    // Cancellations are NOT logged — they're a user choice, not a failure.
    if (error?.name === 'NotAllowedError') {
      const e = new Error('Sign-in cancelled.');
      (e as any).code = 'cancelled';
      throw e;
    }
    if (error?.name === 'InvalidStateError') {
      const e = new Error('This passkey is already registered.');
      (e as any).code = 'invalid_state';
      throw e;
    }
    if (error?.name === 'NotSupportedError') {
      throw new Error('Passkeys are not supported on this device.');
    }
    console.error('Passkey authentication error:', error);
    throw new Error(error?.message || 'Failed to authenticate with passkey');
  }
}

/**
 * Returns true if the browser supports conditional WebAuthn mediation
 * (autofill-style passkey suggestions in the email input).
 */
export async function isConditionalMediationAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    // Method added in 2022+ browsers. Some older ones won't have it.
    const fn = (PublicKeyCredential as any).isConditionalMediationAvailable;
    if (typeof fn !== "function") return false;
    return await fn.call(PublicKeyCredential);
  } catch {
    return false;
  }
}

/**
 * Start a passive passkey listener that surfaces saved passkeys in the email
 * input's autofill dropdown. Resolves with the chosen credential when the user
 * picks one, or null if the browser doesn't support conditional UI or the
 * AbortSignal fires first.
 *
 * Caller MUST pass an AbortController.signal and abort it before doing a manual
 * submit, otherwise the browser holds the credential picker open and our normal
 * flow can't dispatch its own WebAuthn dialog.
 */
export async function startConditionalPasskeyAuth(
  options: any,
  signal: AbortSignal,
): Promise<PublicKeyCredential | null> {
  if (!(await isConditionalMediationAvailable())) return null;

  const publicKey = {
    ...options.publicKey,
    challenge: base64urlToBuffer(options.publicKey.challenge),
    allowCredentials: options.publicKey.allowCredentials?.map((cred: any) => ({
      ...cred,
      id: base64urlToBuffer(cred.id),
    })),
  };

  try {
    const credential = await navigator.credentials.get({
      publicKey,
      mediation: "conditional",
      signal,
    } as CredentialRequestOptions);
    return (credential as PublicKeyCredential) ?? null;
  } catch (err: any) {
    // Aborted (user submitted form manually) or no passkey picked. Either way, swallow.
    if (err?.name === "AbortError" || err?.name === "NotAllowedError") return null;
    console.warn("Conditional passkey auth failed:", err);
    return null;
  }
}

/**
 * Pick a user-friendly label for the platform's biometric prompt.
 * Only used for marketing copy ("Sign in with Face ID") — the native OS prompt
 * shows the right one regardless of what we display.
 */
export function getBiometricLabel(): string {
  if (typeof navigator === "undefined") return "passkey";
  const ua = navigator.userAgent || "";
  const platform = (navigator as any).platform || "";

  // iOS / iPadOS — usually Face ID on modern devices
  if (/iPhone|iPad/.test(ua) || /iPad|iPhone/.test(platform)) return "Face ID";

  // macOS — Touch ID on most modern Macs (M-series, recent Intel with Touch Bar)
  if (/Mac/i.test(platform) || /Macintosh/.test(ua)) return "Touch ID";

  // Windows — Windows Hello (face, fingerprint, or PIN)
  if (/Windows/.test(ua)) return "Windows Hello";

  // Android — fingerprint or face unlock; "screen lock" is the generic term Google uses
  if (/Android/.test(ua)) return "fingerprint";

  return "passkey";
}

/**
 * A descriptive default device name so users don't have to invent one.
 * "MacBook (Touch ID)", "iPhone (Face ID)", "Windows PC (Hello)", etc.
 */
export function detectDeviceName(): string {
  if (typeof navigator === "undefined") return "My device";
  const ua = navigator.userAgent || "";
  const biometric = getBiometricLabel();

  if (/iPhone/.test(ua)) return `iPhone (${biometric})`;
  if (/iPad/.test(ua)) return `iPad (${biometric})`;
  if (/Macintosh/.test(ua)) return `Mac (${biometric})`;
  if (/Windows/.test(ua)) return `Windows PC (${biometric})`;
  if (/Android/.test(ua)) return `Android device (${biometric})`;
  if (/Linux/.test(ua)) return "Linux device";
  return "My device";
}

/**
 * Convert a PublicKeyCredential to a format suitable for sending to the server
 */
export function credentialToJSON(credential: PublicKeyCredential): any {
  const response = credential.response as AuthenticatorAttestationResponse | AuthenticatorAssertionResponse;

  const result: any = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
    },
  };

  if ('attestationObject' in response) {
    // Registration response
    result.response.attestationObject = bufferToBase64url(response.attestationObject);
    if (response.getTransports) {
      result.transports = response.getTransports();
    }
  } else {
    // Authentication response
    result.response.authenticatorData = bufferToBase64url(response.authenticatorData);
    result.response.signature = bufferToBase64url(response.signature);
    if (response.userHandle) {
      result.response.userHandle = bufferToBase64url(response.userHandle);
    }
  }

  return result;
}
