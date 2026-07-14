"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/reui/button";
import { Card } from "@/components/reui/card";

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
      <Card className="w-full items-center gap-4 px-6 py-8 text-center">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold text-foreground">Verifying your link</h1>
          <p className="mt-2 text-sm text-muted-foreground">Please wait while we sign you in.</p>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="w-full items-center gap-4 px-6 py-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <XCircle size={36} strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Verification failed</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
        <Button asChild className="w-full">
          <a href="/auth/login">Back to sign in</a>
        </Button>
      </Card>
    );
  }

  return null;
}

function VerifyFallback() {
  return (
    <Card className="w-full items-center gap-4 px-6 py-8 text-center">
      <Loader2 size={24} className="animate-spin text-muted-foreground" />
      <div>
        <h1 className="text-xl font-semibold text-foreground">Loading</h1>
      </div>
    </Card>
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
