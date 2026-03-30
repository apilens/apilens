"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2, CheckCircle, AlertCircle } from "lucide-react";

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

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [isVerifying, setIsVerifying] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("No reset token provided");
      setIsVerifying(false);
      return;
    }

    // Verify token on mount
    const verifyToken = async () => {
      try {
        const response = await fetch("/api/auth/password-reset/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (!response.ok) {
          const data = await response.json();
          setError(data.error || "Invalid or expired reset link");
          setTokenValid(false);
        } else {
          setTokenValid(true);
        }
      } catch {
        setError("Failed to verify reset link. Please try again.");
        setTokenValid(false);
      } finally {
        setIsVerifying(false);
      }
    };

    void verifyToken();
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("No reset token provided");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/password-reset/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          new_password: newPassword,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to reset password");
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        window.location.href = "/auth/login";
      }, 2000);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isVerifying) {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card">
              <div className="auth-header">
                <Loader2 size={32} className="animate-spin" style={{ margin: "0 auto 16px" }} />
                <h1 className="auth-title">Verifying reset link...</h1>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!tokenValid) {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card">
              <div className="auth-icon-error" style={{ color: "#dc3545", margin: "0 auto 16px" }}>
                <AlertCircle size={36} strokeWidth={1.5} />
              </div>
              <div className="auth-header">
                <h1 className="auth-title">Invalid reset link</h1>
                <p className="auth-description">
                  {error || "This password reset link is invalid or has expired."}
                </p>
              </div>
              <a href="/auth/login" className="auth-submit-btn" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
                Request a new reset link
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card">
              <div className="auth-icon-success" style={{ color: "#28a745", margin: "0 auto 16px" }}>
                <CheckCircle size={36} strokeWidth={1.5} />
              </div>
              <div className="auth-header">
                <h1 className="auth-title">Password reset successful</h1>
                <p className="auth-description">
                  Your password has been reset. Redirecting you to login...
                </p>
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
              <h1 className="auth-title">Set new password</h1>
              <p className="auth-description">
                Choose a strong password for your account.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="auth-form">
              <div className="auth-input-group">
                <label htmlFor="new-password" className="auth-label">
                  New password
                </label>
                <div className="auth-input-wrapper">
                  <input
                    id="new-password"
                    type={showNew ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    className="auth-input"
                    required
                    autoFocus
                    autoComplete="new-password"
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    className="auth-input-toggle"
                    onClick={() => setShowNew(!showNew)}
                    tabIndex={-1}
                  >
                    {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="auth-input-group">
                <label htmlFor="confirm-password" className="auth-label">
                  Confirm password
                </label>
                <div className="auth-input-wrapper">
                  <input
                    id="confirm-password"
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    className="auth-input"
                    required
                    autoComplete="new-password"
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    className="auth-input-toggle"
                    onClick={() => setShowConfirm(!showConfirm)}
                    tabIndex={-1}
                  >
                    {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <>
                  <p className="auth-error">{error}</p>
                  {(error.toLowerCase().includes("invalid") || error.toLowerCase().includes("expired")) && (
                    <a href="/auth/login" className="auth-link-btn">
                      Request a new reset link
                    </a>
                  )}
                </>
              )}

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isSubmitting || !newPassword || !confirmPassword}
              >
                {isSubmitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  "Set new password"
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            <div className="auth-card">
              <div className="auth-header">
                <Loader2 size={32} className="animate-spin" style={{ margin: "0 auto 16px" }} />
                <h1 className="auth-title">Loading...</h1>
              </div>
            </div>
          </div>
        </div>
      </div>
    }>
      <ResetPasswordContent />
    </Suspense>
  );
}
