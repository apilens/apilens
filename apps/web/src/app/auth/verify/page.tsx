"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, XCircle } from "lucide-react";

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

const PENDING_SIGNUP_KEY = "apilens.pending_signup";

async function applyPendingSignupName() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(PENDING_SIGNUP_KEY);
    if (!raw) return;
    localStorage.removeItem(PENDING_SIGNUP_KEY); // one-shot, regardless of outcome
    const pending = JSON.parse(raw) as {
      first_name?: string;
      last_name?: string;
      expires_at?: number;
    };
    if (!pending.expires_at || pending.expires_at < Date.now()) return;
    if (!pending.first_name && !pending.last_name) return;

    await fetch("/api/account/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // /api/account/profile takes a single `name` field — combine both.
        name: [pending.first_name, pending.last_name].filter(Boolean).join(" "),
      }),
    });
  } catch {
    // Best-effort — never block the sign-in.
  }
}

function VerifyContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [error, setError] = useState("");
  const [isVerifying, setIsVerifying] = useState(true);

  useEffect(() => {
    if (!token) {
      setError("Invalid or missing token.");
      setIsVerifying(false);
      return;
    }

    const verify = async () => {
      try {
        const response = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (response.ok) {
          // If this browser stashed a pending signup name (within 1h), apply it
          // to the freshly-signed-in account before navigating.
          await applyPendingSignupName();
          window.location.href = "/";
        } else {
          const data = await response.json();
          setError(data.error || "Verification failed. The link may have expired.");
        }
      } catch {
        setError("Something went wrong. Please try again.");
      } finally {
        setIsVerifying(false);
      }
    };

    verify();
  }, [token]);

  if (isVerifying) {
    return (
      <div className="auth-card">
        <Loader2 size={24} className="auth-spinner animate-spin" />
        <div className="auth-header">
          <h1 className="auth-title">Verifying your link</h1>
          <p className="auth-description">Please wait while we sign you in.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="auth-card">
        <div className="auth-icon-error">
          <XCircle size={36} strokeWidth={1.5} />
        </div>
        <div className="auth-header">
          <h1 className="auth-title">Verification failed</h1>
          <p className="auth-description">{error}</p>
        </div>
        <a href="/auth/login" className="auth-submit-btn auth-action">
          Back to sign in
        </a>
      </div>
    );
  }

  return null;
}

function VerifyFallback() {
  return (
    <div className="auth-card">
      <Loader2 size={24} className="auth-spinner animate-spin" />
      <div className="auth-header">
        <h1 className="auth-title">Loading</h1>
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <div className="auth-split">
      <BrandingPanel />
      <div className="auth-panel">
        <div className="auth-panel-inner">
          <Suspense fallback={<VerifyFallback />}>
            <VerifyContent />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
