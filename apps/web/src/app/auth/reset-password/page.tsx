"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import PasswordStrengthMeter from "@/components/settings/PasswordStrengthMeter";
import { Button } from "@/components/reui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/reui/card";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";
import { Alert, AlertDescription } from "@/components/reui/alert";

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
      <AuthShell>
        <Card className="w-full items-center gap-4 px-6 py-8 text-center">
          <Loader2 size={32} className="animate-spin text-muted-foreground" />
          <h1 className="text-xl font-semibold text-foreground">Verifying reset link...</h1>
        </Card>
      </AuthShell>
    );
  }

  if (!tokenValid) {
    return (
      <AuthShell>
        <Card className="w-full items-center gap-4 px-6 py-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertCircle size={36} strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Invalid reset link</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {error || "This password reset link is invalid or has expired."}
            </p>
          </div>
          <Button asChild className="w-full">
            <a href="/auth/login">Request a new reset link</a>
          </Button>
        </Card>
      </AuthShell>
    );
  }

  if (success) {
    return (
      <AuthShell>
        <Card className="w-full items-center gap-4 px-6 py-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-success/10 text-success">
            <CheckCircle size={36} strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Password reset successful</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your password has been reset. Redirecting you to login...
            </p>
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
          <CardTitle className="text-xl">Set new password</CardTitle>
          <CardDescription>
            Choose a strong password for your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showNew ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  className="pr-9"
                  required
                  autoFocus
                  autoComplete="new-password"
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowNew(!showNew)}
                  tabIndex={-1}
                >
                  {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <PasswordStrengthMeter password={newPassword} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showConfirm ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  className="pr-9"
                  required
                  autoComplete="new-password"
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowConfirm(!showConfirm)}
                  tabIndex={-1}
                >
                  {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <>
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
                {(error.toLowerCase().includes("invalid") || error.toLowerCase().includes("expired")) && (
                  <Button
                    asChild
                    variant="link"
                    size="sm"
                    className="h-auto self-center text-muted-foreground hover:text-foreground"
                  >
                    <a href="/auth/login">Request a new reset link</a>
                  </Button>
                )}
              </>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || !newPassword || !confirmPassword}
            >
              {isSubmitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                "Set new password"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <AuthShell>
        <Card className="w-full items-center gap-4 px-6 py-8 text-center">
          <Loader2 size={32} className="animate-spin text-muted-foreground" />
          <h1 className="text-xl font-semibold text-foreground">Loading...</h1>
        </Card>
      </AuthShell>
    }>
      <ResetPasswordContent />
    </Suspense>
  );
}
