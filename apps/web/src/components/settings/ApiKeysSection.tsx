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
import SettingsCard from "./SettingsCard";
import ConfirmDialog from "./ConfirmDialog";
import { useToast } from "@/hooks/useToast";
import Skeleton from "@/components/ui/Skeleton";
import Alert from "@/components/ui/Alert";

const KEY_NAME_MAX = 100;
const MAX_KEYS = 10;  // Matches MAX_API_KEYS_PER_PROJECT on the backend.

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

export default function ApiKeysSection() {
  const toast = useToast();
  // Adapter so the old (type, message) call sites keep working with the new toast API.
  const showToast = (type: "success" | "error", message: string) => {
    if (type === "success") toast.success(message);
    else toast.error(message);
  };

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

  /* ---- Fetch ---- */

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/account/api-keys");
      if (!res.ok) throw new Error("Failed to fetch API keys");
      const data = await res.json();
      setKeys(data.keys);
    } catch (err) {
      if (!(err instanceof DOMException)) console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  useEffect(() => {
    if (newRawKey) {
      setCopied(false);
      setShowKey(false);
    }
  }, [newRawKey]);

  /* ---- Helpers ---- */

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

  /* ---- Actions ---- */

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setIsCreating(true);
    try {
      const res = await fetch("/api/account/api-keys", {
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
      showToast("success", "API key created — copy it before closing.");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to create API key"
      );
    } finally {
      setIsCreating(false);
    }
  };

  const atKeysLimit = keys.length >= MAX_KEYS;

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
      const res = await fetch(`/api/account/api-keys/${revokeTarget.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to revoke key");
      setKeys((prev) => prev.filter((k) => k.id !== revokeTarget.id));
      showToast("success", "API key revoked");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to revoke API key"
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

  /* ---- Render ---- */

  return (
    <>
      <SettingsCard
        title={keys.length > 0 ? `API Keys · ${keys.length} of ${MAX_KEYS}` : "API Keys"}
        description="Authenticate programmatically via X-API-Key header."
        action={
          !showCreateForm &&
          !newRawKey && (
            <button
              className="settings-btn settings-btn-secondary settings-btn-sm"
              onClick={() => setShowCreateForm(true)}
              disabled={atKeysLimit}
              title={atKeysLimit ? `You've hit the ${MAX_KEYS}-key limit. Revoke an unused key to create another.` : undefined}
            >
              <Plus size={14} />
              Create key
            </button>
          )
        }
      >
        {atKeysLimit && !newRawKey && (
          <div style={{ marginBottom: "16px" }}>
            <Alert variant="warning" title={`You've reached the ${MAX_KEYS}-key limit`}>
              Revoke an unused key to free up a slot.
            </Alert>
          </div>
        )}
        {/* Secret key reveal — inline after creation */}
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
                Store this key securely. It has full access to your account.
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

        {/* Inline create form */}
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
                maxLength={KEY_NAME_MAX}
                autoFocus
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  fontSize: "11px",
                  color: newKeyName.length > KEY_NAME_MAX - 10 ? "var(--danger, #dc2626)" : "var(--text-muted)",
                  marginTop: "2px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {newKeyName.length} / {KEY_NAME_MAX}
              </div>
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

        {/* Keys list / Loading / Empty */}
        {isLoading ? (
          <div className="apikeys-list" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="apikeys-item" style={{ pointerEvents: "none" }}>
                <Skeleton variant="avatar" width={36} height={36} />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px", paddingLeft: "20px" }}>
                  <Skeleton variant="line" width="35%" height={14} />
                  <Skeleton variant="line" width="60%" height={12} />
                </div>
              </div>
            ))}
          </div>
        ) : keys.length === 0 && !hasInlineContent ? (
          <div className="apikeys-empty">
            <div className="apikeys-empty-icon">
              <Shield size={20} />
            </div>
            <div>
              <p className="apikeys-empty-text" style={{ marginBottom: "4px" }}>
                <strong>No API keys yet.</strong>
              </p>
              <p className="apikeys-empty-text" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                Create a key to authenticate from the CLI, CI pipelines, or your own integrations.
              </p>
            </div>
          </div>
        ) : keys.length > 0 ? (
          <div
            className={`apikeys-list${hasInlineContent ? " apikeys-list-separated" : ""}`}
          >
            {keys.map((k) => (
              <div key={k.id} className="apikeys-item">
                <div className="apikeys-item-icon">
                  <Key size={16} />
                </div>
                <div className="apikeys-item-info" style={{ minWidth: 0 }}>
                  <p className="apikeys-item-name truncate-with-tooltip" title={k.name}>
                    {k.name}
                  </p>
                  <p className="apikeys-item-meta">
                    <code className="apikeys-item-prefix">{k.prefix}...</code>
                    <span>Created {formatDate(k.created_at)}</span>
                    <span>
                      Last used: {formatRelativeTime(k.last_used_at)}
                    </span>
                  </p>
                </div>
                <button
                  className="settings-btn settings-btn-ghost settings-btn-sm"
                  onClick={() => setRevokeTarget(k)}
                  aria-label={`Revoke ${k.name}`}
                >
                  <Trash2 size={14} />
                  Revoke
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsCard>

      <ConfirmDialog
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke API key?"
        description={
          revokeTarget
            ? `"${revokeTarget.name}" — last used ${formatRelativeTime(revokeTarget.last_used_at)}. Any integrations using this key will stop working immediately.`
            : ""
        }
        confirmText="Revoke key"
        variant="danger"
        isLoading={isRevoking}
      />
    </>
  );
}
