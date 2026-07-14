"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, AlertCircle, CheckCircle, Mail, Users, X } from "lucide-react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Button } from "@/components/reui/button";
import { Card } from "@/components/reui/card";
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

interface InviteInfo {
  valid: boolean;
  email: string;
  role: string;
  project_name: string;
  project_slug: string;
  inviter: string;
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-split">
      <BrandingPanel />
      <div className="auth-panel">
        <div className="auth-panel-inner">
          <Card className="w-full items-center gap-4 px-6 py-8 text-center">{children}</Card>
        </div>
      </div>
    </div>
  );
}

function InviteContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { user, isLoading: authLoading } = useAuth();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("No invitation token provided");
      setIsLoading(false);
      return;
    }
    const load = async () => {
      try {
        const res = await fetch("/api/auth/invite-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data: InviteInfo = await res.json();
        if (!res.ok || !data.valid) {
          setError("This invitation is invalid or has expired.");
        } else {
          setInfo(data);
        }
      } catch {
        setError("Failed to load invitation. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, [token]);

  const handleAccept = async () => {
    if (!token || !info) return;
    setIsSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/projects/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to accept invitation");
        return;
      }
      setAccepted(true);
      setTimeout(() => {
        window.location.href = `/projects/${info.project_slug}`;
      }, 1200);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDecline = async () => {
    if (!token) return;
    setIsSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/projects/invitations/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to decline invitation");
        return;
      }
      setDeclined(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSwitchAccount = async () => {
    setIsSubmitting(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore — redirect regardless
    }
    const next = token ? `?next=${encodeURIComponent(`/auth/invite?token=${token}`)}` : "";
    window.location.href = `/auth/login${next}`;
  };

  const handleSendLink = async () => {
    if (!info) return;
    setIsSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: info.email }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to send sign-in link");
        return;
      }
      setLinkSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading || authLoading) {
    return (
      <AuthShell>
        <Loader2 size={32} className="animate-spin text-muted-foreground" />
        <h1 className="text-xl font-semibold text-foreground">Loading invitation...</h1>
      </AuthShell>
    );
  }

  if (error && !info) {
    return (
      <AuthShell>
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle size={36} strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Invitation unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
        <Button asChild className="w-full">
          <a href="/projects">Go to API Lens</a>
        </Button>
      </AuthShell>
    );
  }

  if (accepted && info) {
    return (
      <AuthShell>
        <div className="flex size-12 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle size={36} strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">You&apos;re in!</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Taking you to {info.project_name}...
          </p>
        </div>
      </AuthShell>
    );
  }

  if (declined && info) {
    return (
      <AuthShell>
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <X size={36} strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Invitation declined</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You declined the invitation to {info.project_name}. No further action needed.
          </p>
        </div>
        <Button asChild className="w-full">
          <a href="/projects">Go to API Lens</a>
        </Button>
      </AuthShell>
    );
  }

  if (linkSent && info) {
    return (
      <AuthShell>
        <div className="flex size-12 items-center justify-center rounded-full bg-success/10 text-success">
          <Mail size={36} strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Check your email</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We sent a sign-in link to <strong className="text-foreground">{info.email}</strong>. After you sign in,
            accept the invitation from the notification bell to join {info.project_name}.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (!info) return null;

  const roleLabel = info.role.charAt(0).toUpperCase() + info.role.slice(1);
  const isLoggedIn = !!user;
  const emailMatches = isLoggedIn && user?.email?.toLowerCase() === info.email.toLowerCase();

  return (
    <AuthShell>
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Users size={36} strokeWidth={1.5} />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-foreground">Join {info.project_name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {info.inviter ? <><strong className="text-foreground">{info.inviter}</strong> invited you</> : "You've been invited"} to
          collaborate as a <strong className="text-foreground">{roleLabel}</strong>.
        </p>
      </div>

      {error && (
        <Alert variant="destructive" className="text-left">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {emailMatches ? (
        <>
          <Button
            className="w-full"
            onClick={handleAccept}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <><Loader2 size={16} className="animate-spin" /> Joining...</>
            ) : (
              "Accept invitation"
            )}
          </Button>
          <Button
            variant="ghost"
            className="w-full text-muted-foreground hover:text-foreground"
            onClick={handleDecline}
            disabled={isSubmitting}
          >
            Decline
          </Button>
        </>
      ) : isLoggedIn ? (
        <div className="flex w-full flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            This invitation was sent to <strong className="text-foreground">{info.email}</strong>, but you&apos;re signed in as{" "}
            <strong className="text-foreground">{user?.email}</strong>. Sign in with the invited email to accept.
          </p>
          <Button
            className="w-full"
            onClick={handleSwitchAccount}
            disabled={isSubmitting}
          >
            {isSubmitting ? <><Loader2 size={16} className="animate-spin" /> Signing out...</> : "Switch account"}
          </Button>
        </div>
      ) : (
        <Button
          className="w-full"
          onClick={handleSendLink}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <><Loader2 size={16} className="animate-spin" /> Sending link...</>
          ) : (
            <>Sign in as {info.email}</>
          )}
        </Button>
      )}
    </AuthShell>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <Loader2 size={32} className="animate-spin text-muted-foreground" />
          <h1 className="text-xl font-semibold text-foreground">Loading...</h1>
        </AuthShell>
      }
    >
      <InviteContent />
    </Suspense>
  );
}
