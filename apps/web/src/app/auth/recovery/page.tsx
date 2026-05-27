"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Loader2,
  Mail,
  ShieldOff,
  AlertCircle,
  Check,
  Clock,
  XCircle,
} from "lucide-react";

/**
 * Recovery page state machine
 * ───────────────────────────
 * No token in URL                       → `request-form`
 * After requesting                       → `request-sent`
 * With ?token= and ?action=cancel        → `cancel-confirming` → `cancelled`
 * With ?token= alone                     → status fetched, then one of:
 *   - status="pending" && is_ready=false → `countdown`
 *   - status="pending" && is_ready=true  → `ready`
 *   - status="confirmed"                 → `already-confirmed`
 *   - status="cancelled"                 → `already-cancelled`
 *   - status="expired"                   → `expired`
 *   - status="invalid"                   → `invalid-token`
 */

interface StatusPayload {
  status: "pending" | "confirmed" | "cancelled" | "expired" | "invalid";
  email?: string;
  requested_at?: string;
  available_at?: string;
  expires_at?: string;
  is_ready?: boolean;
}

function BrandingPanel() {
  return (
    <div className="auth-branding">
      <div className="auth-branding-content">
        <p className="auth-branding-logo">API Lens</p>
        <h2 className="auth-branding-headline">
          Account recovery,<br />done safely.
        </h2>
        <p className="auth-branding-sub">
          We add a 48-hour cooldown before disabling 2FA so a stolen password alone isn't enough.
        </p>
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

function formatHuman(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function useCountdown(targetIso?: string): { d: number; h: number; m: number; s: number; isDone: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    if (!targetIso) return;
    const i = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [targetIso]);
  const target = targetIso ? new Date(targetIso).getTime() : 0;
  const diff = Math.max(0, target - Date.now());
  const total = Math.floor(diff / 1000);
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
    isDone: diff <= 0,
  };
}

function RecoveryContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const action = searchParams.get("action");

  // ────── Form state (no token) ──────
  const [email, setEmail] = useState("");
  const [isRequesting, setIsRequesting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requestSent, setRequestSent] = useState(false);

  // ────── Status state (with token) ──────
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState("");

  // ────── Action state ──────
  const [actionRunning, setActionRunning] = useState<"confirm" | "cancel" | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionDone, setActionDone] = useState<"confirmed" | "cancelled" | null>(null);

  // Fetch status whenever we have a token.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setIsLoadingStatus(true);
    setStatusError("");
    fetch(`/api/auth/recovery/status?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Status check failed");
        return data as StatusPayload;
      })
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        if (!cancelled) setStatusError(err.message || "Status check failed");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingStatus(false);
      });
    return () => { cancelled = true; };
  }, [token, actionDone]);

  // Re-tick the countdown live and flip to "ready" when due.
  const countdown = useCountdown(status?.available_at);

  // If we have action=cancel in the URL, auto-fire cancel as soon as we know the
  // token is valid (and the user lands directly from the email link).
  const shouldAutoCancel = useMemo(
    () => action === "cancel" && token && status?.status === "pending" && actionDone === null,
    [action, token, status?.status, actionDone],
  );

  useEffect(() => {
    if (!shouldAutoCancel || !token) return;
    void doCancel(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoCancel]);

  // ────── Action handlers ──────
  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setRequestError("");
    if (!email) {
      setRequestError("Enter your email");
      return;
    }
    setIsRequesting(true);
    try {
      const res = await fetch("/api/auth/recovery/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't start recovery");
      setRequestSent(true);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsRequesting(false);
    }
  }

  async function doConfirm(tk: string) {
    setActionError("");
    setActionRunning("confirm");
    try {
      const res = await fetch("/api/auth/recovery/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tk }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't complete recovery");
      setActionDone("confirmed");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setActionRunning(null);
    }
  }

  async function doCancel(tk: string) {
    setActionError("");
    setActionRunning("cancel");
    try {
      const res = await fetch("/api/auth/recovery/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tk }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't cancel");
      setActionDone("cancelled");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setActionRunning(null);
    }
  }

  // ────── Rendering helpers ──────
  function renderStatusCard(): React.ReactNode {
    if (isLoadingStatus) {
      return (
        <div className="auth-card">
          <Loader2 size={24} className="animate-spin" style={{ margin: "0 auto" }} />
          <div className="auth-header" style={{ marginTop: 16 }}>
            <h1 className="auth-title">Checking your recovery request</h1>
          </div>
        </div>
      );
    }

    if (statusError || !status) {
      return statusCard({
        Icon: AlertCircle,
        kicker: "Recovery",
        title: "We couldn't load this recovery",
        body: statusError || "Try opening the link from the email again.",
        actions: <a href="/auth/recovery" className="auth-link-btn">Start a new recovery</a>,
        tone: "error",
      });
    }

    // Action just completed — overlay success states
    if (actionDone === "confirmed") {
      return statusCard({
        Icon: ShieldOff,
        kicker: "Done",
        title: "Two-factor authentication is off",
        body: "Your account is back. You can sign in with your password (or any sign-in method).",
        actions: (
          <a href="/auth/login" className="auth-submit-btn auth-action">
            Sign in <ArrowRight size={14} />
          </a>
        ),
        tone: "success",
      });
    }

    if (actionDone === "cancelled") {
      return statusCard({
        Icon: Check,
        kicker: "Cancelled",
        title: "Recovery cancelled",
        body: "No changes were made to your account. If you didn't initiate this, change your password as a precaution.",
        actions: <a href="/auth/login" className="auth-link-btn">Back to sign in</a>,
        tone: "success",
      });
    }

    // Pure status branches
    if (status.status === "confirmed") {
      return statusCard({
        Icon: ShieldOff,
        kicker: "Already done",
        title: "Recovery already completed",
        body: "Two-factor authentication is off for this account.",
        actions: <a href="/auth/login" className="auth-submit-btn auth-action">Sign in <ArrowRight size={14} /></a>,
        tone: "default",
      });
    }

    if (status.status === "cancelled") {
      return statusCard({
        Icon: XCircle,
        kicker: "Cancelled",
        title: "This recovery was cancelled",
        body: "If you still need to recover access, start a new request below.",
        actions: <a href="/auth/recovery" className="auth-link-btn">Start a new recovery</a>,
        tone: "default",
      });
    }

    if (status.status === "expired") {
      return statusCard({
        Icon: XCircle,
        kicker: "Expired",
        title: "This recovery link has expired",
        body: "Start a new recovery to disable 2FA.",
        actions: <a href="/auth/recovery" className="auth-submit-btn auth-action">Start over <ArrowRight size={14} /></a>,
        tone: "default",
      });
    }

    if (status.status === "invalid") {
      return statusCard({
        Icon: AlertCircle,
        kicker: "Invalid",
        title: "This link isn't valid",
        body: "It may have been tampered with. Start a fresh recovery to try again.",
        actions: <a href="/auth/recovery" className="auth-link-btn">Start a new recovery</a>,
        tone: "error",
      });
    }

    // status.status === "pending"
    const isReady = status.is_ready || countdown.isDone;

    if (isReady) {
      return statusCard({
        Icon: ShieldOff,
        kicker: "Ready",
        title: "You can now disable 2FA",
        body: `The 48-hour cooldown has elapsed for ${status.email}. Click below to disable two-factor authentication and wipe your backup codes.`,
        actions: (
          <>
            {actionError && <p className="auth-error" style={{ width: "100%" }}>{actionError}</p>}
            <button
              type="button"
              className="auth-submit-btn auth-action"
              onClick={() => doConfirm(token!)}
              disabled={actionRunning === "confirm"}
            >
              {actionRunning === "confirm" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>Disable 2FA on my account <ArrowRight size={14} /></>
              )}
            </button>
            <button
              type="button"
              className="auth-link-btn"
              onClick={() => doCancel(token!)}
              disabled={actionRunning !== null}
            >
              Cancel instead — I didn't request this
            </button>
          </>
        ),
        tone: "warning",
      });
    }

    // Pending + not ready → countdown
    return statusCard({
      Icon: Clock,
      kicker: "Cooling down",
      title: `Available ${formatHuman(status.available_at)}`,
      body: (
        <>
          We're holding off on disabling 2FA for <strong>{status.email}</strong> until the cooldown ends.
          You'll be able to continue from this same link then.
        </>
      ),
      actions: (
        <>
          <div
            aria-live="polite"
            style={{
              fontVariantNumeric: "tabular-nums",
              fontSize: "18px",
              fontWeight: 600,
              padding: "12px 16px",
              borderRadius: "10px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-color)",
              display: "flex",
              gap: "16px",
              justifyContent: "center",
              width: "100%",
            }}
          >
            <span><strong>{countdown.d}</strong>d</span>
            <span><strong>{countdown.h}</strong>h</span>
            <span><strong>{countdown.m}</strong>m</span>
            <span><strong>{countdown.s}</strong>s</span>
          </div>
          {actionError && <p className="auth-error" style={{ width: "100%" }}>{actionError}</p>}
          <button
            type="button"
            className="auth-link-btn"
            onClick={() => doCancel(token!)}
            disabled={actionRunning !== null}
          >
            {actionRunning === "cancel" ? "Cancelling…" : "Cancel — I didn't request this"}
          </button>
        </>
      ),
      tone: "default",
    });
  }

  // ────── Render ──────
  if (token) {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            {renderStatusCard()}
          </div>
        </div>
      </div>
    );
  }

  // No token → request form
  if (requestSent) {
    return (
      <div className="auth-split">
        <BrandingPanel />
        <div className="auth-panel">
          <div className="auth-panel-inner">
            {statusCard({
              Icon: Mail,
              kicker: "Almost there",
              title: "Check your email",
              body: (
                <>
                  If <strong>{email}</strong> has an account with 2FA, we sent a recovery link.
                  The recovery will become available <strong>48 hours</strong> after you confirm from your inbox.
                </>
              ),
              actions: (
                <>
                  <button
                    type="button"
                    className="auth-link-btn"
                    onClick={() => setRequestSent(false)}
                  >
                    Use a different email
                  </button>
                  <a href="/auth/login" className="auth-link-btn">
                    Back to sign in
                  </a>
                </>
              ),
              tone: "default",
            })}
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
              <h1 className="auth-title">Recover account access</h1>
              <p className="auth-description">
                Lost both your authenticator and your backup codes? We can disable 2FA after a 48-hour cooldown.
              </p>
            </div>

            <form onSubmit={handleRequest} className="auth-form auth-form-tight">
              <div className="auth-input-group">
                <label htmlFor="email" className="auth-label">
                  Account email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setRequestError("");
                  }}
                  placeholder="you@company.com"
                  className="auth-input"
                  required
                  autoFocus
                  autoComplete="email"
                  disabled={isRequesting}
                />
              </div>

              {requestError && <p className="auth-error">{requestError}</p>}

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isRequesting || !email}
              >
                {isRequesting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <>Start recovery <ArrowRight size={14} /></>
                )}
              </button>

              <p className="auth-footer-note" style={{ fontSize: "12px", marginTop: "12px" }}>
                We'll email you a link. The recovery becomes available 48 hours later — long enough to
                cancel if it wasn't you.
              </p>

              <p className="auth-footer-note">
                Remembered your codes?{" "}
                <a href="/auth/login" className="auth-footer-link-btn">
                  Back to sign in
                </a>
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper for the various status cards — keeps them visually consistent.
function statusCard({
  Icon,
  kicker,
  title,
  body,
  actions,
  tone,
}: {
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  kicker: string;
  title: React.ReactNode;
  body: React.ReactNode;
  actions: React.ReactNode;
  tone: "default" | "success" | "warning" | "error";
}) {
  const iconBg =
    tone === "success" ? "rgba(22, 163, 74, 0.12)"
    : tone === "warning" ? "rgba(245, 158, 11, 0.12)"
    : tone === "error" ? "rgba(220, 38, 38, 0.12)"
    : "var(--bg-tertiary)";
  const iconColor =
    tone === "success" ? "#16a34a"
    : tone === "warning" ? "#f59e0b"
    : tone === "error" ? "#dc2626"
    : "var(--text-secondary)";

  return (
    <div className="auth-card auth-status-card auth-status-minimal">
      <div
        className="auth-icon-primary auth-status-icon"
        style={{ background: iconBg, color: iconColor }}
      >
        <Icon size={24} strokeWidth={1.7} />
      </div>
      <p className="auth-status-kicker">{kicker}</p>
      <h1 className="auth-title">{title}</h1>
      <p className="auth-description auth-status-description">{body}</p>
      <div className="auth-status-divider" aria-hidden="true" />
      <div
        className="auth-status-actions auth-status-actions-minimal"
        style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}
      >
        {actions}
      </div>
    </div>
  );
}

export default function RecoveryPage() {
  return (
    <Suspense
      fallback={
        <div className="auth-split">
          <BrandingPanel />
          <div className="auth-panel">
            <div className="auth-panel-inner">
              <div className="auth-card">
                <Loader2 size={24} className="animate-spin" style={{ margin: "16px auto" }} />
              </div>
            </div>
          </div>
        </div>
      }
    >
      <RecoveryContent />
    </Suspense>
  );
}
