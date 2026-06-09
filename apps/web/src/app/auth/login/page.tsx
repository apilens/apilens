"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, Mail, Eye, EyeOff, Fingerprint } from "lucide-react";
import {
  isPasskeySupported,
  authenticatePasskey,
  credentialToJSON,
  startConditionalPasskeyAuth,
  getBiometricLabel,
} from "@/lib/webauthn";

/**
 * Single-input, smart-routing login.
 *
 * Flow:
 *  1. On mount we start a passive WebAuthn "conditional UI" listener. If the
 *     user has a passkey for this site, the browser surfaces it in the email
 *     field's autofill dropdown. Tapping the suggestion signs them in instantly
 *     — no Continue click required.
 *  2. If they type an email instead, Continue calls /api/auth/identify which
 *     returns one of three methods:
 *       passkey         → trigger an explicit WebAuthn prompt
 *       password        → slide a password input in
 *       magic_link_sent → show "check your email"
 *  3. 2FA, when required, comes from /api/auth/login as a challenge token
 *     (no password resubmission needed).
 */
type FlowState =
  | "input"             // email + Continue (with passive passkey listener)
  | "password"          // password input slides in
  | "passkey-running"   // browser's biometric dialog is up
  | "passkey-fallback"  // user cancelled passkey — show alternatives
  | "2fa-required"      // OTP / backup code
  | "magic-link-sent"
  | "reset-link-sent"
  | "no-account";       // typed email has no account — offer signup

type Method = "passkey" | "password" | "magic_link";

function BrandingPanel() {
  return (
    <div className="auth-branding">
      <div className="auth-branding-content">
        <p className="auth-branding-logo">API Lens</p>
        <h2 className="auth-branding-headline">
          Understand your APIs<br />like never before.
        </h2>
        <p className="auth-branding-sub">
          Monitor, debug, and optimize API performance from a single dashboard.
        </p>
        <div className="auth-branding-features">
          <div className="auth-branding-feature"><span>Real-time monitoring</span></div>
          <div className="auth-branding-feature"><span>Security insights</span></div>
          <div className="auth-branding-feature"><span>Multi-region support</span></div>
        </div>
      </div>
      <div className="auth-branding-footer">
        <a href="mailto:support@apilens.ai" className="auth-footer-link">Support</a>
        <span className="auth-footer-sep" />
        <a href="https://apilens.ai/terms" className="auth-footer-link">Terms</a>
        <span className="auth-footer-sep" />
        <a href="https://apilens.ai/privacy" className="auth-footer-link">Privacy</a>
      </div>
    </div>
  );
}

function LoginPageContent() {
  const searchParams = useSearchParams();
  const [flowState, setFlowState] = useState<FlowState>("input");
  const [email, setEmail] = useState("");

  // Pre-fill email when redirected from /auth/signup with ?email=
  useEffect(() => {
    const fromQuery = searchParams.get("email");
    if (fromQuery) setEmail(fromQuery);
  }, [searchParams]);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [twoFactorChallenge, setTwoFactorChallenge] = useState("");
  // Other methods this user has — surfaced as "or use X" links.
  const [fallbacks, setFallbacks] = useState<Method[]>([]);
  // Cached passkey options so the user can retry the passkey prompt without
  // making another identify round-trip.
  const [passkeyOptions, setPasskeyOptions] = useState<any>(null);
  // Pre-fetched identify result keyed by email. Lets us skip the fetch inside
  // the button click handler so navigator.credentials.get() fires within the
  // original user gesture — required by Safari to trigger Touch ID.
  const [prefetchedIdentify, setPrefetchedIdentify] = useState<{ email: string; data: any } | null>(null);

  // Abort controller for the passive conditional-UI passkey listener.
  // We abort it before doing anything that needs WebAuthn explicitly.
  const conditionalAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void isPasskeySupported().then(setPasskeySupported);
  }, []);

  // Start the conditional UI passkey listener on mount and whenever we return
  // to the input state. Resolves silently if the browser doesn't support it.
  useEffect(() => {
    if (flowState !== "input") return;

    const controller = new AbortController();
    conditionalAbortRef.current = controller;

    (async () => {
      try {
        // Fetch generic passkey options (no email — browser autofill picks any
        // saved passkey for this RP).
        const optionsResponse = await fetch("/api/auth/passkey/login/options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!optionsResponse.ok) return;
        const optionsData = await optionsResponse.json();

        const credential = await startConditionalPasskeyAuth(optionsData, controller.signal);
        if (!credential) return;  // unsupported, aborted, or no pick

        // User picked a passkey from autofill — finish the sign-in.
        await verifyPasskey(credential, optionsData.publicKey.challenge);
      } catch (err) {
        console.warn("Conditional passkey auth failed:", err);
      }
    })();

    return () => {
      controller.abort();
      if (conditionalAbortRef.current === controller) {
        conditionalAbortRef.current = null;
      }
    };
  }, [flowState]);

  const abortConditionalAuth = () => {
    conditionalAbortRef.current?.abort();
    conditionalAbortRef.current = null;
  };

  const verifyPasskey = async (credential: PublicKeyCredential, challenge: string) => {
    const credentialJSON = credentialToJSON(credential);
    const verifyResponse = await fetch("/api/auth/passkey/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: credentialJSON, challenge }),
    });
    if (!verifyResponse.ok) {
      const data = await verifyResponse.json().catch(() => ({}));
      throw new Error(data.error || "Failed to verify passkey");
    }
    window.location.href = "/";
  };

  // Pre-fetch the identify result when the user leaves the email field.
  // This lets handleIdentify skip the fetch entirely when the user clicks
  // "Continue", so navigator.credentials.get() fires without any prior await
  // — Safari requires this to honour the user gesture and show Touch ID.
  const handleEmailBlur = async () => {
    const trimmed = email.trim();
    if (!trimmed || prefetchedIdentify?.email === trimmed) return;
    try {
      const res = await fetch("/api/auth/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setPrefetchedIdentify({ email: trimmed, data });
    } catch {
      // Silently ignore — handleIdentify will fall back to a fresh fetch.
    }
  };

  const handleIdentify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email) {
      setError("Please enter your email");
      return;
    }

    abortConditionalAuth();
    setIsSubmitting(true);

    // Fast path: use the pre-fetched result so navigator.credentials.get() is
    // called immediately within the user gesture (required by Safari for Touch ID).
    const prefetched = prefetchedIdentify?.email === email ? prefetchedIdentify.data : null;
    if (prefetched?.method === "passkey" && prefetched.passkey_options) {
      const incomingFallbacks: Method[] = Array.isArray(prefetched.fallbacks) ? prefetched.fallbacks : [];
      setFallbacks(incomingFallbacks);
      setPasskeyOptions(prefetched.passkey_options);
      try {
        await runPasskeyFlow(prefetched.passkey_options, incomingFallbacks);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // Slow path: fetch then handle (non-passkey methods, or prefetch missed).
    try {
      const response = await fetch("/api/auth/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Something went wrong");
        return;
      }

      const incomingFallbacks: Method[] = Array.isArray(data.fallbacks) ? data.fallbacks : [];
      setFallbacks(incomingFallbacks);

      if (data.method === "passkey" && data.passkey_options) {
        setPasskeyOptions(data.passkey_options);
        await runPasskeyFlow(data.passkey_options, incomingFallbacks);
      } else if (data.method === "password") {
        setFlowState("password");
      } else if (data.method === "magic_link_sent") {
        setFlowState("magic-link-sent");
      } else if (data.method === "no_account") {
        setFlowState("no-account");
      } else {
        setError("Unexpected response. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const runPasskeyFlow = async (options: any, availableFallbacks?: Method[]) => {
    setFlowState("passkey-running");
    setError("");
    try {
      const credential = await authenticatePasskey(options);
      await verifyPasskey(credential, options.publicKey.challenge);
    } catch (err: any) {
      const code = err?.code;
      const fb = availableFallbacks ?? fallbacks;
      if (code === "cancelled") {
        // User dismissed the biometric prompt. Don't shout — give them the
        // alternatives instead of dumping them back at the email field.
        if (fb.length > 0) {
          setFlowState("passkey-fallback");
        } else {
          // No fallbacks → quietly return to input.
          setFlowState("input");
        }
        return;
      }
      // Real error (not a cancellation)
      setFlowState(fb.length > 0 ? "passkey-fallback" : "input");
      setError(err?.message || "Couldn't sign in with passkey.");
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!password) {
      setError("Please enter your password");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember_me: rememberMe }),
      });
      const data = await response.json();

      if (!response.ok) {
        if (data.code === "magic_link_only") {
          // User has no usable password — send them a magic link instead.
          await sendMagicLink();
        } else {
          setError(data.error || "Invalid email or password");
        }
        return;
      }

      if (data.twofa_required && data.challenge_token) {
        setTwoFactorChallenge(data.challenge_token);
        setFlowState("2fa-required");
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const sendMagicLink = async () => {
    setError("");
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Failed to send magic link");
        return;
      }
      setFlowState("magic-link-sent");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      setError("Please enter your email first");
      return;
    }
    setIsSubmitting(true);
    try {
      await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setFlowState("reset-link-sent");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTwoFactorVerify = async () => {
    if (!twoFactorCode || (useBackupCode ? twoFactorCode.length < 8 : twoFactorCode.length !== 6)) {
      setError(useBackupCode ? "Please enter a valid backup code" : "Please enter a 6-digit code");
      return;
    }

    if (!twoFactorChallenge) {
      setError("Sign-in session expired. Please log in again.");
      setFlowState("input");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/2fa/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge_token: twoFactorChallenge,
          code: twoFactorCode,
          remember_me: rememberMe,
          use_backup_code: useBackupCode,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Invalid verification code");
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const backToInput = () => {
    setFlowState("input");
    setPassword("");
    setTwoFactorCode("");
    setTwoFactorChallenge("");
    setError("");
    setFallbacks([]);
    setPasskeyOptions(null);
  };

  // ──────────────────────────────────────────────────────────────────
  // Passkey fallback — user cancelled or it failed; offer alternatives
  // ──────────────────────────────────────────────────────────────────
  if (flowState === "passkey-fallback") {
    const canRetryPasskey = !!passkeyOptions;
    const canUsePassword = fallbacks.includes("password");
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card">
              <p className="auth-mobile-logo">API Lens</p>
              <div className="auth-header">
                <h1 className="auth-title">How would you like to sign in?</h1>
                <p className="auth-description">
                  Signing in as <strong>{email}</strong>
                </p>
              </div>
              {error && <p className="auth-error">{error}</p>}

              <div className="auth-form auth-form-tight">
                {canRetryPasskey && (
                  <button
                    type="button"
                    className="auth-submit-btn"
                    onClick={() => void runPasskeyFlow(passkeyOptions)}
                    disabled={isSubmitting}
                  >
                    <Fingerprint size={16} />
                    Try {getBiometricLabel()} again
                  </button>
                )}

                {canUsePassword && (
                  <button
                    type="button"
                    className={canRetryPasskey ? "settings-btn settings-btn-secondary" : "auth-submit-btn"}
                    onClick={() => {
                      setError("");
                      setFlowState("password");
                    }}
                    disabled={isSubmitting}
                  >
                    Use my password
                  </button>
                )}

                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => void sendMagicLink()}
                  disabled={isSubmitting}
                >
                  Email me a sign-in link instead
                </button>

                <button type="button" className="auth-link-btn" onClick={backToInput}>
                  Use a different email
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // 2FA screen
  // ──────────────────────────────────────────────────────────────────
  if (flowState === "2fa-required") {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card">
              <p className="auth-mobile-logo">API Lens</p>
              <div className="auth-header">
                <h1 className="auth-title">Two-Factor Authentication</h1>
                <p className="auth-description">
                  {useBackupCode
                    ? "Enter one of your backup codes"
                    : "Enter the 6-digit code from your authenticator app"}
                </p>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleTwoFactorVerify();
                }}
                className="auth-form auth-form-tight"
              >
                <div className="auth-input-group">
                  <label htmlFor="twofa-code" className="auth-label">
                    {useBackupCode ? "Backup Code" : "Verification Code"}
                  </label>
                  <input
                    id="twofa-code"
                    type="text"
                    inputMode={useBackupCode ? "text" : "numeric"}
                    value={twoFactorCode}
                    onChange={(e) => {
                      const value = useBackupCode
                        ? e.target.value.toUpperCase()
                        : e.target.value.replace(/\D/g, "");
                      setTwoFactorCode(value);
                      setError("");
                    }}
                    placeholder={useBackupCode ? "XXXX-XXXX" : "000000"}
                    maxLength={useBackupCode ? 9 : 6}
                    className="auth-input"
                    required
                    autoFocus
                    disabled={isSubmitting}
                  />
                </div>

                {error && <p className="auth-error">{error}</p>}

                <button
                  type="submit"
                  className="auth-submit-btn"
                  disabled={isSubmitting || !twoFactorCode}
                >
                  {isSubmitting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <>
                      Verify and Sign In
                      <ArrowRight size={14} />
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => setUseBackupCode(!useBackupCode)}
                >
                  {useBackupCode ? "Use authenticator code instead" : "Use backup code"}
                </button>

                <a
                  href={`/auth/recovery${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                  className="auth-link-btn"
                  style={{ display: "inline-block" }}
                >
                  Lost access to your codes?
                </a>

                <button type="button" className="auth-link-btn" onClick={backToInput}>
                  Back to sign in
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // No account found — offer signup
  // ──────────────────────────────────────────────────────────────────
  if (flowState === "no-account") {
    const signupUrl = `/auth/signup?email=${encodeURIComponent(email)}`;
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card auth-status-card auth-status-minimal">
              <div className="auth-icon-primary auth-status-icon">
                <Mail size={24} strokeWidth={1.7} />
              </div>
              <p className="auth-status-kicker">No account found</p>
              <h1 className="auth-title">Create one in seconds?</h1>
              <p className="auth-description auth-status-description">
                We couldn't find an API Lens account for this email.
              </p>
              <p className="auth-status-email">
                <span className="auth-status-email-label">Searched for</span>
                <strong>{email}</strong>
              </p>
              <div className="auth-status-divider" aria-hidden="true" />
              <div className="auth-status-actions auth-status-actions-minimal">
                <a href={signupUrl} className="auth-submit-btn auth-action">
                  Sign up with this email <ArrowRight size={14} />
                </a>
                <button className="auth-link-btn" onClick={backToInput}>
                  Try a different email
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Reset link sent
  // ──────────────────────────────────────────────────────────────────
  if (flowState === "reset-link-sent") {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card auth-status-card auth-status-minimal">
              <div className="auth-icon-primary auth-status-icon">
                <Mail size={24} strokeWidth={1.7} />
              </div>
              <p className="auth-status-kicker">Password Reset</p>
              <h1 className="auth-title">Check your email</h1>
              <p className="auth-description auth-status-description">
                If an account exists for this email, we've sent a link to reset your password.
              </p>
              <p className="auth-status-email">
                <span className="auth-status-email-label">Sent to</span>
                <strong>{email}</strong>
              </p>
              <div className="auth-status-divider" aria-hidden="true" />
              <div className="auth-status-actions auth-status-actions-minimal">
                <button className="auth-link-btn" onClick={backToInput}>
                  Back to sign in
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Magic link sent
  // ──────────────────────────────────────────────────────────────────
  if (flowState === "magic-link-sent") {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card auth-status-card auth-status-minimal">
              <div className="auth-icon-primary auth-status-icon">
                <Mail size={24} strokeWidth={1.7} />
              </div>
              <p className="auth-status-kicker">Magic Link Sent</p>
              <h1 className="auth-title">Check your email</h1>
              <p className="auth-description auth-status-description">
                Open the link to sign in.
              </p>
              <p className="auth-status-email">
                <span className="auth-status-email-label">Sent to</span>
                <strong>{email}</strong>
              </p>
              <div className="auth-status-divider" aria-hidden="true" />
              <div className="auth-status-actions auth-status-actions-minimal">
                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => void sendMagicLink()}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Sending..." : "Resend link"}
                </button>
                <button className="auth-link-btn" onClick={backToInput}>
                  Change email
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Passkey running (browser dialog is up)
  // ──────────────────────────────────────────────────────────────────
  if (flowState === "passkey-running") {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card auth-status-card auth-status-minimal">
              <div className="auth-icon-primary auth-status-icon">
                <Fingerprint size={28} strokeWidth={1.7} />
              </div>
              <p className="auth-status-kicker">Signing in</p>
              <h1 className="auth-title">
                Authenticate with {getBiometricLabel()}
              </h1>
              <p className="auth-description auth-status-description">
                Follow the prompt on your device.
              </p>
              <Loader2 size={20} className="animate-spin" style={{ margin: "12px auto" }} />
              <div className="auth-status-divider" aria-hidden="true" />
              <div className="auth-status-actions auth-status-actions-minimal">
                {fallbacks.length > 0 ? (
                  <button
                    className="auth-link-btn"
                    onClick={() => setFlowState("passkey-fallback")}
                  >
                    Cancel and use another way
                  </button>
                ) : (
                  <button className="auth-link-btn" onClick={backToInput}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Password screen (slides in after identify resolves to password)
  // ──────────────────────────────────────────────────────────────────
  if (flowState === "password") {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card">
              <p className="auth-mobile-logo">API Lens</p>
              <div className="auth-header">
                <h1 className="auth-title">Enter your password</h1>
                <p className="auth-description">
                  Signing in as <strong>{email}</strong>
                </p>
              </div>

              <form onSubmit={handlePasswordLogin} className="auth-form auth-form-tight">
                <div className="auth-input-group">
                  <div className="auth-label-row">
                    <label htmlFor="password" className="auth-label">Password</label>
                    <button
                      type="button"
                      className="auth-forgot-link"
                      onClick={handleForgotPassword}
                      disabled={isSubmitting}
                    >
                      Forgot?
                    </button>
                  </div>
                  <div className="auth-input-wrapper">
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError("");
                      }}
                      placeholder="Your password"
                      className="auth-input"
                      required
                      autoFocus
                      autoComplete="current-password"
                      disabled={isSubmitting}
                    />
                    <button
                      type="button"
                      className="auth-input-toggle"
                      onClick={() => setShowPassword(!showPassword)}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <label className="auth-checkbox-label">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    disabled={isSubmitting}
                  />
                  <span className="auth-checkbox-box">
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  Remember me for 30 days
                </label>

                {error && <p className="auth-error">{error}</p>}

                <button
                  type="submit"
                  className="auth-submit-btn"
                  disabled={isSubmitting || !password}
                >
                  {isSubmitting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <>Sign in <ArrowRight size={14} /></>
                  )}
                </button>

                {fallbacks.includes("passkey") && passkeyOptions && (
                  <button
                    type="button"
                    className="auth-link-btn"
                    onClick={() => void runPasskeyFlow(passkeyOptions)}
                    disabled={isSubmitting}
                  >
                    <Fingerprint size={14} style={{ verticalAlign: "-2px", marginRight: "4px" }} />
                    Use {getBiometricLabel()} instead
                  </button>
                )}

                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => void sendMagicLink()}
                  disabled={isSubmitting}
                >
                  Email me a sign-in link instead
                </button>

                <button type="button" className="auth-link-btn" onClick={backToInput}>
                  Use a different email
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Default: input state — single email field
  // ──────────────────────────────────────────────────────────────────
  return (
    <div className="auth-split">
      <BrandingPanel />
      <div className="auth-panel">
        <div className="auth-panel-inner">
          <div className="auth-card">
            <p className="auth-mobile-logo">API Lens</p>
            <div className="auth-header">
              <h1 className="auth-title">Sign in to API Lens</h1>
              <p className="auth-description">
                Enter your email — we'll take you to the right step.
              </p>
            </div>

            <form onSubmit={handleIdentify} className="auth-form auth-form-tight">
              <div className="auth-input-group">
                <label htmlFor="email" className="auth-label">Email address</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError("");
                    setPrefetchedIdentify(null);
                  }}
                  onBlur={handleEmailBlur}
                  placeholder="you@company.com"
                  className="auth-input"
                  required
                  autoFocus
                  // Critical for conditional WebAuthn — surfaces saved passkeys
                  // alongside saved email autofill suggestions.
                  autoComplete="username webauthn"
                  disabled={isSubmitting}
                />
              </div>

              {error && <p className="auth-error">{error}</p>}

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isSubmitting || !email}
              >
                {isSubmitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <>Continue <ArrowRight size={14} /></>
                )}
              </button>

              <p className="auth-footer-note">
                Don't have an account?{" "}
                <a href="/auth/signup" className="auth-footer-link-btn">
                  Sign up
                </a>
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="auth-split">
          <BrandingPanel />
          <div className="auth-panel">
            <div className="auth-panel-inner">
              <div className="auth-card">
                <Loader2 size={24} className="animate-spin" style={{ margin: "16px auto" }} />
              </div>
            </div>
          </div>
        </div>
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}
