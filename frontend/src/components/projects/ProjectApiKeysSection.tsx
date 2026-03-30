"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Loader2,
  Eye,
  EyeOff,
  AlertTriangle,
  Shield,
} from "lucide-react";
import SettingsCard from "@/components/settings/SettingsCard";
import ConfirmDialog from "@/components/settings/ConfirmDialog";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

interface ProjectApiKeysSectionProps {
  projectSlug: string;
  showToast: (type: "success" | "error", message: string) => void;
}

export default function ProjectApiKeysSection({ projectSlug, showToast }: ProjectApiKeysSectionProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectSlug}/api-keys`);
      if (!res.ok) throw new Error("Failed to fetch API keys");
      const data = await res.json();
      setKeys(data.keys);
    } catch (err) {
      if (!(err instanceof DOMException)) console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  useEffect(() => {
    if (newRawKey) {
      setCopied(false);
      setShowKey(false);
    }
  }, [newRawKey]);

  const maskKey = (key: string) => {
    if (key.length <= 12) return "*".repeat(key.length);
    return `${key.slice(0, 12)}${"*".repeat(key.length - 12)}`;
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const formatRelativeTime = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return formatDate(dateStr);
  };

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setIsCreating(true);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create key");
      setNewRawKey(data.key);
      setNewKeyName("");
      setShowCreateForm(false);
      await fetchKeys();
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to create API key",
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("error", "Failed to copy. Copy manually.");
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setIsRevoking(true);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/api-keys/${revokeTarget.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to revoke key");
      setKeys((prev) => prev.filter((k) => k.id !== revokeTarget.id));
      showToast("success", "API key revoked");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to revoke API key",
      );
    } finally {
      setIsRevoking(false);
      setRevokeTarget(null);
    }
  };

  const cancelCreate = () => {
    setShowCreateForm(false);
    setNewKeyName("");
  };

  const dismissNewKey = () => {
    setNewRawKey(null);
    setShowKey(false);
    setCopied(false);
  };

  const hasInlineContent = showCreateForm || !!newRawKey;

  return (
    <>
      <SettingsCard
        title="API Keys"
        description="Project-level API keys work across all apps in this project. Use them to send telemetry data via the APILens SDK."
        action={
          !showCreateForm &&
          !newRawKey && (
            <button
              className="settings-btn settings-btn-secondary settings-btn-sm"
              onClick={() => setShowCreateForm(true)}
            >
              <Plus size={14} />
              Create key
            </button>
          )
        }
      >
        {newRawKey && (
          <div className="apikeys-reveal">
            <div className="apikeys-reveal-header">
              <div className="apikeys-reveal-icon">
                <Key size={16} />
              </div>
              <div>
                <p className="apikeys-reveal-title">Your new API key</p>
                <p className="apikeys-reveal-subtitle">
                  Copy it now — you won&apos;t be able to see it again.
                </p>
              </div>
            </div>
            <div className="apikeys-reveal-value">
              <code className="apikeys-reveal-code">
                {showKey ? newRawKey : maskKey(newRawKey)}
              </code>
              <div className="apikeys-reveal-actions">
                <button
                  className="settings-btn settings-btn-ghost settings-btn-sm"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  className="settings-btn settings-btn-ghost settings-btn-sm"
                  onClick={() => handleCopy(newRawKey)}
                  aria-label="Copy key"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className="apikeys-reveal-warning">
              <AlertTriangle size={14} />
              <span>
                Store this key securely. It has access to all apps in this project.
              </span>
            </div>
            <button
              className="settings-btn settings-btn-secondary settings-btn-sm"
              onClick={dismissNewKey}
              style={{ width: "100%" }}
            >
              I&apos;ve copied it
            </button>
          </div>
        )}

        {showCreateForm && !newRawKey && (
          <div className="apikeys-create-form">
            <div className="apikeys-create-field">
              <label className="apikeys-label" htmlFor="apikey-name">
                Key name
              </label>
              <input
                id="apikey-name"
                className="apikeys-input"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newKeyName.trim()) handleCreate();
                  if (e.key === "Escape") cancelCreate();
                }}
                placeholder="e.g. Production, CI/CD, Local dev"
                maxLength={100}
                autoFocus
              />
            </div>
            <div className="apikeys-create-actions">
              <button
                className="settings-btn settings-btn-secondary settings-btn-sm"
                onClick={cancelCreate}
              >
                Cancel
              </button>
              <button
                className="settings-btn settings-btn-primary settings-btn-sm"
                disabled={isCreating || !newKeyName.trim()}
                onClick={handleCreate}
              >
                {isCreating ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create key"
                )}
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="sessions-loading">
            <Loader2 size={18} className="animate-spin" />
            <span>Loading API keys...</span>
          </div>
        ) : keys.length === 0 && !hasInlineContent ? (
          <div className="apikeys-empty">
            <div className="apikeys-empty-icon">
              <Shield size={20} />
            </div>
            <p className="apikeys-empty-text">
              No API keys yet. Create one to start sending data from your apps.
            </p>
          </div>
        ) : keys.length > 0 ? (
          <div className={`project-apikeys-list${hasInlineContent ? " project-apikeys-list-separated" : ""}`}>
            {keys.map((k) => (
              <div key={k.id} className="project-apikey-row">
                <div className="project-apikey-main">
                  <div className="apikeys-item-icon">
                    <Key size={16} />
                  </div>
                  <div className="apikeys-item-info">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <p className="apikeys-item-name">{k.name}</p>
                      <code className="apikeys-item-prefix">{k.prefix}...••••••••</code>
                    </div>
                    <p className="apikeys-item-subtitle">
                      Created {formatDate(k.created_at)} · Last used {formatRelativeTime(k.last_used_at)}
                    </p>
                  </div>
                </div>

                <div className="project-apikey-row-action">
                  <button
                    className="settings-btn settings-btn-ghost settings-btn-sm"
                    onClick={() => setRevokeTarget(k)}
                    aria-label={`Revoke ${k.name}`}
                  >
                    <Trash2 size={14} />
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsCard>

      <ConfirmDialog
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke API Key"
        description={`Revoke "${revokeTarget?.name}"? This will break all integrations using this key.`}
        confirmText="Revoke"
        variant="danger"
        isLoading={isRevoking}
      />
    </>
  );
}
