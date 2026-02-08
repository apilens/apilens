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
  Clock,
  Shield,
} from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

interface ApiKeysSectionProps {
  showToast: (type: "success" | "error", message: string) => void;
}

export default function ApiKeysSection({ showToast }: ApiKeysSectionProps) {
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

  /* ---------------- Fetch Keys ---------------- */

  const fetchKeys = useCallback(async () => {
    const controller = new AbortController();
    try {
      const res = await fetch("/api/account/api-keys", {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Failed to fetch API keys");
      const data = await res.json();
      setKeys(data.keys);
    } catch (err) {
      if (!(err instanceof DOMException)) {
        console.error(err);
      }
    } finally {
      setIsLoading(false);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  /* ---------------- Helpers ---------------- */

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

  /* ---------------- Actions ---------------- */

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
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Failed to create API key"
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
      const res = await fetch(
        `/api/account/api-keys/${revokeTarget.id}`,
        { method: "DELETE" }
      );

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

  const dismissNewKey = () => {
    setNewRawKey(null);
    setShowKey(false);
    setCopied(false);
  };

  /* ---------------- Render ---------------- */

  return (
    <>
      Working On it
    {/*  /!* Header *!/*/}
    {/*  <div className="apikeys-header">*/}
    {/*    <div>*/}
    {/*      <h2 className="apikeys-title">API Keys</h2>*/}
    {/*      <p className="apikeys-description">*/}
    {/*        Manage API keys for programmatic access via{" "}*/}
    {/*        <code>X-API-Key</code>.*/}
    {/*      </p>*/}
    {/*    </div>*/}
    {/*    {!showCreateForm && !newRawKey && (*/}
    {/*      <button*/}
    {/*        className="settings-btn settings-btn-primary"*/}
    {/*        onClick={() => setShowCreateForm(true)}*/}
    {/*      >*/}
    {/*        <Plus size={16} />*/}
    {/*        Create new key*/}
    {/*      </button>*/}
    {/*    )}*/}
    {/*  </div>*/}

    {/*  /!* Create Form *!/*/}
    {/*  {showCreateForm && !newRawKey && (*/}
    {/*    <div className="apikeys-create-card">*/}
    {/*      <label>Key name</label>*/}
    {/*      <input*/}
    {/*        value={newKeyName}*/}
    {/*        onChange={(e) => setNewKeyName(e.target.value)}*/}
    {/*        onKeyDown={(e) => {*/}
    {/*          if (e.key === "Enter") handleCreate();*/}
    {/*          if (e.key === "Escape") {*/}
    {/*            setShowCreateForm(false);*/}
    {/*            setNewKeyName("");*/}
    {/*          }*/}
    {/*        }}*/}
    {/*        placeholder="Production / CI / Local"*/}
    {/*        autoFocus*/}
    {/*      />*/}
    {/*      <div className="apikeys-create-actions">*/}
    {/*        <button*/}
    {/*          className="settings-btn settings-btn-secondary"*/}
    {/*          onClick={() => setShowCreateForm(false)}*/}
    {/*        >*/}
    {/*          Cancel*/}
    {/*        </button>*/}
    {/*        <button*/}
    {/*          className="settings-btn settings-btn-primary"*/}
    {/*          disabled={isCreating || !newKeyName.trim()}*/}
    {/*          onClick={handleCreate}*/}
    {/*        >*/}
    {/*          {isCreating ? (*/}
    {/*            <>*/}
    {/*              <Loader2 size={14} className="animate-spin" />*/}
    {/*              Creating...*/}
    {/*            </>*/}
    {/*          ) : (*/}
    {/*            "Create key"*/}
    {/*          )}*/}
    {/*        </button>*/}
    {/*      </div>*/}
    {/*    </div>*/}
    {/*  )}*/}

    {/*  /!* New Key *!/*/}
    {/*  {newRawKey && (*/}
    {/*    <div className="apikeys-secret-card">*/}
    {/*      <h3>Your new API key</h3>*/}
    {/*      <code>{showKey ? newRawKey : maskKey(newRawKey)}</code>*/}
    {/*      <div>*/}
    {/*        <button onClick={() => setShowKey(!showKey)}>*/}
    {/*          {showKey ? <EyeOff size={16} /> : <Eye size={16} />}*/}
    {/*        </button>*/}
    {/*        <button onClick={() => handleCopy(newRawKey)}>*/}
    {/*          {copied ? <Check size={16} /> : <Copy size={16} />}*/}
    {/*          {copied ? "Copied" : "Copy"}*/}
    {/*        </button>*/}
    {/*      </div>*/}
    {/*      <div className="apikeys-secret-warning">*/}
    {/*        <AlertTriangle size={14} />*/}
    {/*        This key won’t be shown again.*/}
    {/*      </div>*/}
    {/*      <button*/}
    {/*        className="settings-btn settings-btn-secondary"*/}
    {/*        onClick={dismissNewKey}*/}
    {/*      >*/}
    {/*        I’ve copied it*/}
    {/*      </button>*/}
    {/*    </div>*/}
    {/*  )}*/}

    {/*  /!* List *!/*/}
    {/*  {isLoading ? (*/}
    {/*    <div className="apikeys-loading">*/}
    {/*      <Loader2 size={20} className="animate-spin" />*/}
    {/*      Loading...*/}
    {/*    </div>*/}
    {/*  ) : keys.length === 0 ? (*/}
    {/*    <div className="apikeys-empty">*/}
    {/*      <Shield size={32} />*/}
    {/*      <p>No API keys yet</p>*/}
    {/*    </div>*/}
    {/*  ) : (*/}
    {/*    <div className="apikeys-list">*/}
    {/*      {keys.map((k) => (*/}
    {/*        <div key={k.id} className="apikeys-row">*/}
    {/*          <span>{k.name}</span>*/}
    {/*          <code>{k.prefix}...</code>*/}
    {/*          <span>{formatDate(k.created_at)}</span>*/}
    {/*          <span>{formatRelativeTime(k.last_used_at)}</span>*/}
    {/*          <button onClick={() => setRevokeTarget(k)}>*/}
    {/*            <Trash2 size={14} /> Revoke*/}
    {/*          </button>*/}
    {/*        </div>*/}
    {/*      ))}*/}
    {/*    </div>*/}
    {/*  )}*/}

    {/*  <ConfirmDialog*/}
    {/*    isOpen={!!revokeTarget}*/}
    {/*    onClose={() => setRevokeTarget(null)}*/}
    {/*    onConfirm={handleRevoke}*/}
    {/*    title="Revoke API Key"*/}
    {/*    description={`Revoke "${revokeTarget?.name}"? This breaks integrations immediately.`}*/}
    {/*    confirmText="Revoke"*/}
    {/*    variant="danger"*/}
    {/*    isLoading={isRevoking}*/}
    {/*  />*/}
    </>
  );
}
