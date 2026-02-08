"use client";

import { useState, useEffect, useCallback } from "react";
import { Monitor, Smartphone, Loader2, LogOut } from "lucide-react";
import SettingsCard from "./SettingsCard";

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
  onLogoutAll: () => Promise<void>;
}

const POLL_INTERVAL = 30_000; // 30 seconds

export default function SessionsSection({ onLogoutAll }: SessionsSectionProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [isLoggingOutAll, setIsLoggingOutAll] = useState(false);
  const [, setTick] = useState(0);

  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/account/sessions");
      if (response.ok) {
        const data = await response.json();
        setSessions(data.sessions);
      }
    } catch (error) {
      console.error("Error fetching sessions:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  // Tick every 30s to re-render relative times
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const handleRevoke = async (sessionId: string) => {
    setRevokingId(sessionId);
    try {
      const response = await fetch(`/api/account/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }
    } catch (error) {
      console.error("Error revoking session:", error);
    } finally {
      setRevokingId(null);
    }
  };

  const handleLogoutAll = async () => {
    setIsLoggingOutAll(true);
    try {
      await onLogoutAll();
    } finally {
      setIsLoggingOutAll(false);
    }
  };

  function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
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

  function parseDevice(ua: string): { name: string; isMobile: boolean } {
    if (!ua || ua.length <= 50) return { name: ua || "Unknown device", isMobile: false };

    const isMobile = /iPhone|iPad|Android|Mobile/i.test(ua);
    let browser = "Web Browser";
    let os = "";

    // Browser detection — order matters (Edge UA includes Chrome & Safari)
    if (ua.includes("Edg/") || ua.includes("Edge/")) browser = "Edge";
    else if (ua.includes("Chrome/") && !ua.includes("Edg/")) browser = "Chrome";
    else if (ua.includes("Firefox/")) browser = "Firefox";
    else if (ua.includes("Safari/") && !ua.includes("Chrome/")) browser = "Safari";

    // OS
    if (ua.includes("Mac OS X")) os = "macOS";
    else if (ua.includes("Windows")) os = "Windows";
    else if (ua.includes("Linux") && !ua.includes("Android")) os = "Linux";
    else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
    else if (ua.includes("Android")) os = "Android";

    return {
      name: os ? `${browser} on ${os}` : browser,
      isMobile,
    };
  }

  return (
    <SettingsCard
      title="Active Sessions"
      description="Devices where you're currently signed in"
      action={
        sessions.length > 1 && (
          <button
            className="settings-btn settings-btn-ghost"
            onClick={handleLogoutAll}
            disabled={isLoggingOutAll}
          >
            {isLoggingOutAll ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <LogOut size={14} />
            )}
            Sign out other devices
          </button>
        )
      }
    >
      {isLoading ? (
        <div className="sessions-loading">
          <Loader2 size={18} className="animate-spin" />
          <span>Loading sessions...</span>
        </div>
      ) : sessions.length === 0 ? (
        <p className="sessions-empty">No active sessions.</p>
      ) : (
        <div className="sessions-list">
          {sessions.map((session) => {
            const device = parseDevice(session.device_info);
            const DeviceIcon = device.isMobile ? Smartphone : Monitor;
            return (
              <div key={session.id} className="session-item">
                <div className="session-icon">
                  <DeviceIcon size={16} />
                </div>
                <div className="session-info">
                  <p className="session-device">{device.name}</p>
                  <p className="session-details">
                    {(session.location || session.ip_address) && (
                      <span>{session.location || session.ip_address}</span>
                    )}
                    <span>{formatRelativeTime(session.last_used_at)}</span>
                  </p>
                </div>
                {session.is_current ? (
                  <span className="session-current-badge">This device</span>
                ) : (
                  <button
                    className="settings-btn settings-btn-ghost settings-btn-sm"
                    onClick={() => handleRevoke(session.id)}
                    disabled={revokingId === session.id}
                    aria-label="Revoke session"
                  >
                    {revokingId === session.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <LogOut size={14} />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SettingsCard>
  );
}
