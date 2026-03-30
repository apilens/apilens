"use client";

import { useState, useEffect } from "react";
import { ArrowRight, Loader2, Mail, Eye, EyeOff, Fingerprint } from "lucide-react";
import { isPasskeySupported, authenticatePasskey, credentialToJSON } from "@/lib/webauthn";

type AuthMethod = "magic-link" | "password" | "passkey";
type FlowState = "input" | "magic-link-sent" | "2fa-required";

export default function LoginPage() {
  const [flowState, setFlowState] = useState<FlowState>("input");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("magic-link");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);

  useEffect(() => {
    void isPasskeySupported().then(setPasskeySupported);
  }, []);

  const handleContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (authMethod === "password") {
      return handlePasswordLogin();
    }

    if (authMethod === "passkey") {
      return handlePasskeyLogin();
    }

    // Default: magic link
    await sendMagicLink();
  };

  const sendMagicLink = async () => {
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

  const handlePasswordLogin = async () => {
    setIsSubmitting(true);
    try {
      // First check if user has 2FA enabled
      const checkResponse = await fetch("/api/auth/check-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (checkResponse.ok) {
        const checkData = await checkResponse.json();
        if (checkData.has_2fa) {
          // User has 2FA enabled, show 2FA verification screen
          setFlowState("2fa-required");
          setIsSubmitting(false);
          return;
        }
      }

      // No 2FA, proceed with normal login
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember_me: rememberMe }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Invalid email or password");
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setError("");
    setIsSubmitting(true);

    try {
      const optionsResponse = await fetch("/api/auth/passkey/login/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!optionsResponse.ok) {
        const data = await optionsResponse.json();
        setError(data.error || "Failed to start passkey login");
        return;
      }

      const optionsData = await optionsResponse.json();
      const credential = await authenticatePasskey(optionsData);
      const credentialJSON = credentialToJSON(credential);

      const verifyResponse = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential: credentialJSON,
          challenge: optionsData.publicKey.challenge,
        }),
      });

      if (!verifyResponse.ok) {
        const data = await verifyResponse.json();
        setError(data.error || "Failed to verify passkey");
        return;
      }

      window.location.href = "/";
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      setError("Please enter your email first");
      return;
    }
    await sendMagicLink();
  };

  const handleTwoFactorVerify = async () => {
    if (!twoFactorCode || (useBackupCode ? twoFactorCode.length < 8 : twoFactorCode.length !== 6)) {
      setError(useBackupCode ? "Please enter a valid backup code" : "Please enter a 6-digit code");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/2fa/verify-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
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

  if (flowState === "2fa-required") {
    return (
      <div className="auth-split">
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

                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => {
                    setFlowState("input");
                    setTwoFactorCode("");
                    setPassword("");
                    setError("");
                  }}
                >
                  Back to login
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (flowState === "magic-link-sent") {
    return (
      <div className="auth-split">
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
                <button
                  className="auth-link-btn"
                  onClick={() => {
                    setFlowState("input");
                    setPassword("");
                    setError("");
                  }}
                >
                  Change email
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-split">
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
      <div className="auth-panel">
        <div className="auth-panel-inner">
          <div className="auth-card">
            <p className="auth-mobile-logo">API Lens</p>
            <div className="auth-header">
              <h1 className="auth-title">Welcome back</h1>
              <p className="auth-description">Sign in to continue to API Lens</p>
            </div>

            <form onSubmit={handleContinue} className="auth-form auth-form-tight">
              {/* Method Selector */}
              <div className="auth-method-selector">
                <button
                  type="button"
                  className={`auth-method-tab${authMethod === "magic-link" ? " active" : ""}`}
                  onClick={() => {
                    setAuthMethod("magic-link");
                    setError("");
                  }}
                >
                  <Mail size={16} />
                  Email Link
                </button>
                <button
                  type="button"
                  className={`auth-method-tab${authMethod === "password" ? " active" : ""}`}
                  onClick={() => {
                    setAuthMethod("password");
                    setError("");
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                  Password
                </button>
                {passkeySupported && (
                  <button
                    type="button"
                    className={`auth-method-tab${authMethod === "passkey" ? " active" : ""}`}
                    onClick={() => {
                      setAuthMethod("passkey");
                      setError("");
                    }}
                  >
                    <Fingerprint size={16} />
                    Passkey
                  </button>
                )}
              </div>
              {/* Email field - always visible */}
              <div className="auth-input-group">
                <label htmlFor="email" className="auth-label">Email address</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError("");
                  }}
                  placeholder="you@company.com"
                  className="auth-input"
                  required
                  autoFocus
                  autoComplete="email"
                  disabled={isSubmitting}
                />
              </div>

              {/* Password field - only for password method */}
              {authMethod === "password" && (
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
                      placeholder="Enter your password"
                      className="auth-input"
                      required
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
              )}

              {/* Passkey info - only for passkey method */}
              {authMethod === "passkey" && (
                <div className="auth-passkey-info">
                  <div className="auth-passkey-info-icon">
                    <Fingerprint size={24} />
                  </div>
                  <p className="auth-passkey-info-text">
                    You'll be prompted to verify your identity using your device's biometric authentication or security key.
                  </p>
                </div>
              )}

              {/* Magic link info */}
              {authMethod === "magic-link" && (
                <p className="auth-inline-note show">
                  We'll send you a secure link to sign in. No password needed.
                </p>
              )}

              {/* Remember me - only for password */}
              {authMethod === "password" && (
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
              )}

              {error && <p className="auth-error">{error}</p>}

              {/* Submit button */}
              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isSubmitting || !email}
              >
                {isSubmitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : authMethod === "passkey" ? (
                  <>
                    <Fingerprint size={16} />
                    Continue with passkey
                  </>
                ) : authMethod === "password" ? (
                  <>
                    Sign in
                    <ArrowRight size={14} />
                  </>
                ) : (
                  <>
                    Send magic link
                    <Mail size={14} />
                  </>
                )}
              </button>

              {/* Helper text - context aware */}
              {authMethod === "magic-link" ? (
                <p className="auth-footer-note">
                  Enter your email and we'll send you a secure link to access your account.
                </p>
              ) : (
                <p className="auth-footer-note">
                  Don't have an account?{" "}
                  <button
                    type="button"
                    className="auth-footer-link-btn"
                    onClick={() => setAuthMethod("magic-link")}
                  >
                    Get started with email
                  </button>
                </p>
              )}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
