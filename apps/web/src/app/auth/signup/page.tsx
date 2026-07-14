"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Info, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/reui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/reui/card";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";

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

/** Shared right-panel wrapper: keeps the split layout contract classes. */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-split">
      <BrandingPanel />
      <div className="auth-panel">
        <div className="auth-panel-inner">{children}</div>
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
      <AuthShell>
        <Card className="w-full items-center gap-4 px-6 py-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Mail size={24} strokeWidth={1.7} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Check your email</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We sent a link to finish creating your account.
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="mr-1.5">Sent to</span>
            <strong className="text-foreground">{email}</strong>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto text-muted-foreground hover:text-foreground"
              onClick={() => setSent(false)}
            >
              Use a different email
            </Button>
            <span className="h-3 w-px bg-border" aria-hidden="true" />
            <Button
              asChild
              variant="link"
              size="sm"
              className="h-auto text-muted-foreground hover:text-foreground"
            >
              <a href="/auth/login">Back to sign in</a>
            </Button>
          </div>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Card className="w-full gap-5">
        <CardHeader className="text-center">
          <p className="auth-mobile-logo">API Lens</p>
          <CardTitle className="text-xl">Create your account</CardTitle>
          <CardDescription>
            Free to start. No credit card required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="first-name">First name</Label>
                <Input
                  id="first-name"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Ada"
                  autoComplete="given-name"
                  disabled={isSubmitting}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="last-name">Last name</Label>
                <Input
                  id="last-name"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Lovelace"
                  autoComplete="family-name"
                  disabled={isSubmitting}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                  setAccountExists(false);
                }}
                placeholder="you@company.com"
                required
                autoFocus
                autoComplete="email"
                disabled={isSubmitting}
              />
            </div>

            {accountExists && (
              <Alert variant="info" role="status">
                <Info />
                <AlertTitle>This email is already registered.</AlertTitle>
                <AlertDescription>
                  Sign in instead, or pick a different email below.
                  <Button asChild variant="outline" size="sm" className="mt-1">
                    <a href={`/auth/login?email=${encodeURIComponent(email)}`}>
                      Sign in as {email} <ArrowRight size={14} />
                    </a>
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || !email || accountExists}
            >
              {isSubmitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>Create account <ArrowRight size={14} /></>
              )}
            </Button>

            <p className="mt-2 text-center text-xs leading-relaxed text-muted-foreground">
              By continuing you agree to our{" "}
              <a href="https://apilens.ai/terms" className="font-medium text-primary hover:underline">Terms</a>
              {" "}and{" "}
              <a href="https://apilens.ai/privacy" className="font-medium text-primary hover:underline">Privacy Policy</a>.
            </p>

            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <a href="/auth/login" className="font-medium text-primary hover:underline">
                Sign in
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <Card className="w-full items-center px-6 py-8">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </Card>
        </AuthShell>
      }
    >
      <SignupContent />
    </Suspense>
  );
}
