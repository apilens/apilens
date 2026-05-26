"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, Mail } from "lucide-react";

/**
 * Signup flow — explicit entry point for new users.
 *
 * Collects email and optional name, sends a magic link. The user clicks the
 * link to verify ownership; the verify page picks up `apilens.pending_signup`
 * from localStorage on the same browser and PATCHes the profile so the new
 * account starts with the name they entered.
 *
 * Cross-browser case (link opened on phone, signup done on desktop): the name
 * just won't apply. Users can fill it in from Account Settings later.
 */
const PENDING_SIGNUP_KEY = "apilens.pending_signup";

function BrandingPanel() {
  return (
    <div className="auth-branding">
      <div className="auth-branding-content">
        <p className="auth-branding-logo">API Lens</p>
        <h2 className="auth-branding-headline">
          Built for teams who<br />ship fast.
        </h2>
        <p className="auth-branding-sub">
          Start monitoring your APIs in under a minute. No credit card needed.
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

function SignupContent() {
  const searchParams = useSearchParams();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [accountExists, setAccountExists] = useState(false);

  // Pre-fill email if redirected from /auth/login with ?email=
  useEffect(() => {
    const fromQuery = searchParams.get("email");
    if (fromQuery) setEmail(fromQuery);
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setAccountExists(false);

    if (!email) {
      setError("Please enter your email");
      return;
    }

    setIsSubmitting(true);

    try {
      // First check whether this email already has an account.
      // If yes, surface "Sign in instead?" instead of silently sending a link.
      const identify = await fetch("/api/auth/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const identifyData = await identify.json().catch(() => ({}));
      if (identify.ok && identifyData.method && identifyData.method !== "no_account") {
        // Existing account — redirect them to sign-in instead.
        setAccountExists(true);
        return;
      }

      // Brand new email — stash name (if any) for post-verify hookup
      try {
        const payload = {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.toLowerCase().trim(),
          // 1-hour expiry — magic link itself expires in 15 min, so this is safe.
          expires_at: Date.now() + 60 * 60 * 1000,
        };
        if (payload.first_name || payload.last_name) {
          localStorage.setItem(PENDING_SIGNUP_KEY, JSON.stringify(payload));
        }
      } catch {
        // localStorage blocked — name just won't apply.
      }

      // Send the magic link that will create the account on verify.
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || "Couldn't start sign-up. Please try again.");
        return;
      }

      setSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card auth-status-card">
              <div className="auth-icon-primary">
                <Mail size={24} strokeWidth={1.7} />
              </div>
              <h1 className="auth-title">Check your email</h1>
              <p className="auth-description auth-status-description">
                We sent a link to finish creating your account.
              </p>
              <p className="auth-status-email">
                <span className="auth-status-email-label">Sent to</span>
                <strong>{email}</strong>
              </p>
              <div className="auth-status-actions" style={{ marginTop: "20px" }}>
                <button
                  type="button"
                  className="auth-link-btn"
                  onClick={() => setSent(false)}
                >
                  Use a different email
                </button>
                <span className="auth-footer-sep" aria-hidden="true" />
                <a href="/auth/login" className="auth-link-btn">
                  Back to sign in
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-split">
      <BrandingPanel />
      <div className="auth-panel">
        <div className="auth-panel-inner">
          <div className="auth-card">
            <p className="auth-mobile-logo">API Lens</p>
            <div className="auth-header">
              <h1 className="auth-title">Create your account</h1>
              <p className="auth-description">
                Free to start. No credit card required.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="auth-form auth-form-tight">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div className="auth-input-group">
                  <label htmlFor="first-name" className="auth-label">First name</label>
                  <input
                    id="first-name"
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Ada"
                    className="auth-input"
                    autoComplete="given-name"
                    disabled={isSubmitting}
                  />
                </div>
                <div className="auth-input-group">
                  <label htmlFor="last-name" className="auth-label">Last name</label>
                  <input
                    id="last-name"
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Lovelace"
                    className="auth-input"
                    autoComplete="family-name"
                    disabled={isSubmitting}
                  />
                </div>
              </div>

              <div className="auth-input-group">
                <label htmlFor="email" className="auth-label">Work email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError("");
                    setAccountExists(false);
                  }}
                  placeholder="you@company.com"
                  className="auth-input"
                  required
                  autoFocus
                  autoComplete="email"
                  disabled={isSubmitting}
                />
              </div>

              {accountExists && (
                <div
                  role="status"
                  style={{
                    padding: "12px 14px",
                    background: "#eff6ff",
                    border: "1px solid #bfdbfe",
                    borderRadius: "8px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                >
                  <p style={{ margin: 0, fontSize: "13px", color: "#1e3a8a", lineHeight: 1.5 }}>
                    <strong>This email is already registered.</strong> Sign in instead, or pick a different email below.
                  </p>
                  <a
                    href={`/auth/login?email=${encodeURIComponent(email)}`}
                    className="settings-btn settings-btn-primary settings-btn-sm"
                    style={{ alignSelf: "flex-start", textDecoration: "none" }}
                  >
                    Sign in as {email} <ArrowRight size={14} />
                  </a>
                </div>
              )}

              {error && <p className="auth-error">{error}</p>}

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isSubmitting || !email || accountExists}
              >
                {isSubmitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <>Create account <ArrowRight size={14} /></>
                )}
              </button>

              <p className="auth-footer-note" style={{ marginTop: "16px", fontSize: "12px", lineHeight: 1.5 }}>
                By continuing you agree to our{" "}
                <a href="https://apilens.ai/terms" className="auth-footer-link-btn">Terms</a>
                {" "}and{" "}
                <a href="https://apilens.ai/privacy" className="auth-footer-link-btn">Privacy Policy</a>.
              </p>

              <p className="auth-footer-note">
                Already have an account?{" "}
                <a href="/auth/login" className="auth-footer-link-btn">
                  Sign in
                </a>
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="auth-split">
          <BrandingPanel />
          <div className="auth-panel">
            <div className="auth-panel-inner">
              <div className="auth-card">
                <div className="auth-header">
                  <Loader2 size={24} className="animate-spin" style={{ margin: "0 auto" }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
