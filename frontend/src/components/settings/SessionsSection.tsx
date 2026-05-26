"use client";

import { useState, useEffect } from "react";
import { Monitor, Smartphone, Loader2, LogOut, RotateCw } from "lucide-react";
import SettingsCard from "./SettingsCard";
import ConfirmDialog from "./ConfirmDialog";
import Skeleton from "@/components/ui/Skeleton";
import SectionError from "@/components/ui/SectionError";
import { useFetchWithRetry } from "@/hooks/useFetchWithRetry";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useToast } from "@/hooks/useToast";

interface Session {
  id: string;
  device_info: string;
  ip_address: string | null;
  location: string;
  last_used_at: string;
  created_at: string;
  is_current: boolean;
}

interface SessionsSectionProps {
  onLogoutOthers: () => Promise<void>;
  timezone: string;
  lastLoginAt: string | null;
  memberSince: string | null;
}

const POLL_INTERVAL_MS = 30_000;

function parseDevice(ua: string): { name: string; isMobile: boolean } {
  if (!ua || ua.length <= 50) return { name: ua || "Unknown device", isMobile: false };
  const isMobile = /iPhone|iPad|Android|Mobile/i.test(ua);
  let browser = "Web Browser";
  let os = "";
  if (ua.includes("Edg/") || ua.includes("Edge/")) browser = "Edge";
  else if (ua.includes("Chrome/") && !ua.includes("Edg/")) browser = "Chrome";
  else if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Safari/") && !ua.includes("Chrome/")) browser = "Safari";
  if (ua.includes("Mac OS X")) os = "macOS";
  else if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Linux") && !ua.includes("Android")) os = "Linux";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  else if (ua.includes("Android")) os = "Android";
  return { name: os ? `${browser} on ${os}` : browser, isMobile };
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffSecs < 60) return "Active now";
  if (diffMins < 60) return `Active ${diffMins}m ago`;
  if (diffHours < 24) return `Active ${diffHours}h ago`;
  if (diffDays < 7) return `Active ${diffDays}d ago`;
  return `Active ${date.toLocaleDateString()}`;
}

export default function SessionsSection({
  onLogoutOthers,
  timezone,
  lastLoginAt,
  memberSince,
}: SessionsSectionProps) {
  const toast = useToast();

  const {
    data: sessions,
    isLoading,
    isRetrying,
    error: fetchError,
    retry: refetch,
    setData,
  } = useFetchWithRetry<Session[]>({
    fetcher: async () => {
      const res = await fetch("/api/account/sessions");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load sessions");
      }
      const json = await res.json();
      return (json.sessions ?? []) as Session[];
    },
    retryCount: 2,
    retryDelayMs: 1500,
  });

  // Background polling — only while there's no error and we already have data.
  // Keeps relative times fresh and surfaces new sessions from other devices.
  useEffect(() => {
    if (fetchError || isLoading) return;
    const id = setInterval(refetch, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchError, isLoading, refetch]);

  // Tick every 30s so relative time text re-renders even between fetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const [confirmRevoke, setConfirmRevoke] = useState<Session | null>(null);
  const [confirmLogoutOthers, setConfirmLogoutOthers] = useState(false);

  const revoke = useAsyncAction(
    async (sessionId: string) => {
      const res = await fetch(`/api/account/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to sign out that session");
      }
      // Optimistic local removal — refetch shortly to reconcile.
      setData((prev) => (prev ?? []).filter((s) => s.id !== sessionId));
    },
    {
      onSuccess: () => toast.success("Session signed out"),
      onError: (err) => {
        toast.error(err.message || "Couldn't sign out that session");
        void refetch();  // refetch to undo any optimistic state if mismatched
      },
    },
  );

  const logoutOthersAction = useAsyncAction(
    async () => {
      await onLogoutOthers();
      await refetch();
    },
    {
      // onLogoutOthers handles its own toast via useAccountSettings; nothing extra here.
    },
  );

  const handleRevokeClick = (session: Session) => setConfirmRevoke(session);

  const doRevoke = async () => {
    if (!confirmRevoke) return;
    await revoke.run(confirmRevoke.id);
    setConfirmRevoke(null);
  };

  const doLogoutOthers = async () => {
    await logoutOthersAction.run();
    setConfirmLogoutOthers(false);
  };

  function formatAbsoluteTime(dateStr: string): string {
    const date = new Date(dateStr);
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  // ── Header action (sign out others) ────────────────────────────────
  const headerAction = (sessions?.length ?? 0) > 1 ? (
    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
      <button
        className="settings-btn settings-btn-ghost settings-btn-icon"
        onClick={() => refetch()}
        disabled={isRetrying}
        aria-label="Refresh sessions"
        title="Refresh"
      >
        {isRetrying ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
      </button>
      <button
        className="settings-btn settings-btn-ghost"
        onClick={() => setConfirmLogoutOthers(true)}
        disabled={logoutOthersAction.isRunning}
      >
        {logoutOthersAction.isRunning ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
        Sign out other devices
      </button>
    </div>
  ) : (
    // Single session — still expose refresh.
    <button
      className="settings-btn settings-btn-ghost settings-btn-icon"
      onClick={() => refetch()}
      disabled={isRetrying || isLoading}
      aria-label="Refresh sessions"
      title="Refresh"
    >
      {(isRetrying || isLoading) ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
    </button>
  );

  return (
    <SettingsCard
      title={
        sessions && sessions.length > 0
          ? `Active Sessions · ${sessions.length}`
          : "Active Sessions"
      }
      description="Devices where you're currently signed in"
      action={headerAction}
    >
      {/* Loading: skeletons, not the empty-state copy. */}
      {isLoading && !sessions ? (
        <div className="sessions-list" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="session-item" style={{ pointerEvents: "none" }}>
              <Skeleton variant="avatar" width={36} height={36} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px", paddingLeft: "14px" }}>
                <Skeleton variant="line" width="40%" height={14} />
                <Skeleton variant="line" width="60%" height={12} />
              </div>
            </div>
          ))}
        </div>
      ) : fetchError && !sessions ? (
        <SectionError
          title="Couldn't load your sessions"
          message={fetchError.message}
          onRetry={refetch}
        />
      ) : !sessions || sessions.length === 0 ? (
        <p className="sessions-empty">
          You're only signed in on this device. Sessions from other browsers or devices will appear here.
        </p>
      ) : (
        <div className="sessions-list">
          {sessions.map((session) => {
            const device = parseDevice(session.device_info);
            const DeviceIcon = device.isMobile ? Smartphone : Monitor;
            const isRevoking = revoke.isRunning && confirmRevoke?.id === session.id;
            return (
              <div key={session.id} className="session-item">
                <div className="session-icon">
                  <DeviceIcon size={16} />
                </div>
                <div className="session-info" style={{ minWidth: 0 }}>
                  <p className="session-device truncate-with-tooltip" title={device.name}>
                    {device.name}
                  </p>
                  <p className="session-details">
                    {(session.location || session.ip_address) && (
                      <span className="truncate-with-tooltip" title={session.location || session.ip_address || ""}>
                        {session.location || session.ip_address}
                      </span>
                    )}
                    <span>{formatRelativeTime(session.last_used_at)}</span>
                  </p>
                </div>
                {session.is_current ? (
                  <span className="session-current-badge">This device</span>
                ) : (
                  <button
                    className="settings-btn settings-btn-ghost settings-btn-sm"
                    onClick={() => handleRevokeClick(session)}
                    disabled={isRevoking}
                    aria-label={`Sign out ${device.name}`}
                  >
                    {isRevoking ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="sessions-footer-meta">
        <span className="sessions-footer-item">
          Last login {lastLoginAt ? formatAbsoluteTime(lastLoginAt) : "—"}
        </span>
        <span className="sessions-footer-item">
          Member since {memberSince ? formatAbsoluteTime(memberSince) : "—"}
        </span>
      </div>

      <ConfirmDialog
        isOpen={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={doRevoke}
        title="Sign out this session?"
        description={
          confirmRevoke
            ? `${parseDevice(confirmRevoke.device_info).name} — ${confirmRevoke.location || confirmRevoke.ip_address || "Unknown location"}. That device will be signed out immediately.`
            : ""
        }
        confirmText="Sign out"
        variant="danger"
        isLoading={revoke.isRunning}
      />

      <ConfirmDialog
        isOpen={confirmLogoutOthers}
        onClose={() => setConfirmLogoutOthers(false)}
        onConfirm={doLogoutOthers}
        title="Sign out all other devices?"
        description="You'll stay signed in here. Every other browser and device will be signed out immediately."
        confirmText="Sign out others"
        variant="danger"
        isLoading={logoutOthersAction.isRunning}
      />
    </SettingsCard>
  );
}
