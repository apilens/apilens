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
    console.error('Passkey registration error:', error);

    // Provide user-friendly error messages
    if (error.name === 'InvalidStateError') {
      throw new Error('This device already has a passkey registered. Please use a different device or delete the existing passkey first.');
    } else if (error.name === 'NotAllowedError') {
      throw new Error('Passkey registration was cancelled or timed out');
    } else if (error.name === 'NotSupportedError') {
      throw new Error('Passkeys are not supported on this device');
    }

    throw new Error(error.message || 'Failed to register passkey');
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
    console.error('Passkey authentication error:', error);

    // Provide user-friendly error messages
    if (error.name === 'NotAllowedError') {
      throw new Error('Authentication was cancelled or timed out');
    } else if (error.name === 'InvalidStateError') {
      throw new Error('This passkey is already registered');
    } else if (error.name === 'NotSupportedError') {
      throw new Error('Passkeys are not supported on this device');
    }

    throw new Error(error.message || 'Failed to authenticate with passkey');
  }
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
