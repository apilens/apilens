"use client";

import { useState } from "react";
import { ArrowRight, Loader2, Mail, Eye, EyeOff, Zap, Shield, Globe } from "lucide-react";

type ViewState = "default" | "magic-link-sent" | "forgot-sent";

export default function LoginPage() {
  const [view, setView] = useState<ViewState>("default");
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

  // — "Check your email" states —
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
              <div className="auth-branding-feature"><Zap size={16} /><span>Real-time monitoring</span></div>
              <div className="auth-branding-feature"><Shield size={16} /><span>Security insights</span></div>
              <div className="auth-branding-feature"><Globe size={16} /><span>Multi-region support</span></div>
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
              <div className="auth-icon-primary">
                <Mail size={36} strokeWidth={1.5} />
              </div>
              <div className="auth-header">
                <h1 className="auth-title">Check your email</h1>
                <p className="auth-description">
                  {isForgot ? (
                    <>
                      We sent a password reset link to <strong>{email}</strong>.
                      Click the link in the email to reset your password.
                    </>
                  ) : (
                    <>
                      We sent a login link to <strong>{email}</strong>.
                      Click the link in the email to sign in.
                    </>
                  )}
                </p>
              </div>
              <button
                className="auth-link-btn auth-action"
                onClick={() => {
                  setView("default");
                  setPassword("");
                  setError("");
                }}
              >
                Back to login
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // — Default: password login form —
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
            <div className="auth-branding-feature"><Zap size={16} /><span>Real-time monitoring</span></div>
            <div className="auth-branding-feature"><Shield size={16} /><span>Security insights</span></div>
            <div className="auth-branding-feature"><Globe size={16} /><span>Multi-region support</span></div>
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
              <h1 className="auth-title">Sign in</h1>
              <p className="auth-description">
                Enter your credentials to continue
              </p>
            </div>

            <form onSubmit={handlePasswordLogin} className="auth-form">
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
                  disabled={isSubmitting}
                >
                  Forgot password?
                </button>
              </div>

              {error && <p className="auth-error">{error}</p>}

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isSubmitting || !email || !password}
              >
                {isSubmitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <>
                    Log in
                    <ArrowRight size={14} />
                  </>
                )}
              </button>
            </form>

            <div className="auth-divider">
              <span>or</span>
            </div>

            <button
              type="button"
              className="auth-magic-link-btn"
              onClick={handleMagicLink}
              disabled={isSubmitting}
            >
              <Mail size={16} />
              Sign in with magic link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
