"use client";

import { useState } from "react";
import { ArrowRight, Loader2, Mail, Eye, EyeOff, KeyRound } from "lucide-react";

type ViewState = "default" | "magic-link-sent" | "forgot-sent";
type AuthMode = "magic" | "password";

export default function LoginPage() {
  const [view, setView] = useState<ViewState>("default");
  const [authMode, setAuthMode] = useState<AuthMode>("magic");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember_me: rememberMe }),
      });

      const data = await response.json();

      if (!response.ok) {
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

  const handleMagicLink = async () => {
    if (!email) {
      setError("Please enter your email first");
      return;
    }
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to send magic link");
        return;
      }

      setView("magic-link-sent");
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
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, flow: "reset" }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to send reset link");
        return;
      }

      setView("forgot-sent");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (view === "magic-link-sent" || view === "forgot-sent") {
    const isForgot = view === "forgot-sent";
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
              <p className="auth-status-kicker">{isForgot ? "Reset Link Sent" : "Magic Link Sent"}</p>
              <h1 className="auth-title">Check your email</h1>
              <p className="auth-description auth-status-description">
                {isForgot ? "Open the link to continue password reset." : "Open the link to sign in."}
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
                  onClick={() => {
                    if (isForgot) {
                      void handleForgotPassword();
                    } else {
                      void handleMagicLink();
                    }
                  }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Sending..." : "Resend link"}
                </button>
                <button
                  className="auth-link-btn"
                  onClick={() => {
                    setView("default");
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
              <h1 className="auth-title">Welcome</h1>
              <p className="auth-description">
                Use email link to sign in or create your account.
              </p>
            </div>

            <div className={`auth-mode-switch auth-mode-${authMode}`} role="tablist" aria-label="Authentication mode">
              <span className="auth-mode-indicator" aria-hidden="true" />
              <button
                type="button"
                className={`auth-mode-btn${authMode === "magic" ? " active" : ""}`}
                onClick={() => {
                  setAuthMode("magic");
                  setError("");
                }}
                role="tab"
                aria-selected={authMode === "magic"}
              >
                <span className="auth-mode-btn-icon" aria-hidden="true">
                  <Mail size={13} />
                </span>
                <span>Email link</span>
              </button>
              <button
                type="button"
                className={`auth-mode-btn${authMode === "password" ? " active" : ""}`}
                onClick={() => {
                  setAuthMode("password");
                  setError("");
                }}
                role="tab"
                aria-selected={authMode === "password"}
              >
                <span className="auth-mode-btn-icon" aria-hidden="true">
                  <KeyRound size={13} />
                </span>
                <span>Password</span>
              </button>
            </div>

            <form onSubmit={authMode === "password" ? handlePasswordLogin : (e) => { e.preventDefault(); void handleMagicLink(); }} className="auth-form auth-form-tight">
              <div className="auth-input-group">
                <label htmlFor="email" className="auth-label">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="auth-input"
                  required
                  autoFocus
                  autoComplete="email"
                  disabled={isSubmitting}
                />
              </div>

              <div className={`auth-password-region${authMode === "password" ? " open" : ""}`} aria-hidden={authMode !== "password"}>
                <div className="auth-password-region-inner">
                  <div className="auth-input-group">
                    <label htmlFor="password" className="auth-label">Password</label>
                    <div className="auth-input-wrapper">
                      <input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter your password"
                        className="auth-input"
                        required={authMode === "password"}
                        autoComplete="current-password"
                        disabled={isSubmitting || authMode !== "password"}
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

                  <div className="auth-form-options">
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
                      Remember me
                    </label>
                    <button
                      type="button"
                      className="auth-forgot-link"
                      onClick={handleForgotPassword}
                      disabled={isSubmitting || authMode !== "password"}
                    >
                      Forgot password?
                    </button>
                  </div>
                </div>
              </div>

              <p className={`auth-inline-note auth-inline-note-magic${authMode === "magic" ? " show" : ""}`}>
                New here? No signup form needed. We create your account after email verification.
              </p>

              {error && <p className="auth-error">{error}</p>}

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isSubmitting || !email || (authMode === "password" && !password)}
              >
                {isSubmitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : authMode === "magic" ? (
                  <>
                    Send secure link
                    <ArrowRight size={14} />
                  </>
                ) : (
                  <>
                    Log in
                    <ArrowRight size={14} />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
