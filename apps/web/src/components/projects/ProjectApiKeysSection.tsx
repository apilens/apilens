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
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";

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
            <Button variant="outline" size="sm" onClick={() => setShowCreateForm(true)}>
              <Plus size={14} />
              Create key
            </Button>
          )
        }
      >
        {newRawKey && (
          <div className="mb-3.5 flex flex-col gap-5 rounded-xl border border-border bg-muted/40 p-6">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
                <Key size={16} />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Your new API key</p>
                <p className="text-xs text-muted-foreground">
                  Copy it now — you won&apos;t be able to see it again.
                </p>
              </div>
            </div>
            <div className="flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background px-3.5 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[13px] leading-snug text-foreground">
                {showKey ? newRawKey : maskKey(newRawKey)}
              </code>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy(newRawKey)}
                  aria-label="Copy key"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-warning/15 bg-warning/10 px-3 py-2.5 text-xs text-warning">
              <AlertTriangle size={14} className="shrink-0" />
              <span>
                Store this key securely. It has access to all apps in this project.
              </span>
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={dismissNewKey}>
              I&apos;ve copied it
            </Button>
          </div>
        )}

        {showCreateForm && !newRawKey && (
          <div className="mb-3.5 flex flex-col gap-5 rounded-xl border border-border bg-muted/40 p-6">
            <div className="flex flex-col gap-2">
              <Label htmlFor="apikey-name" className="text-xs text-muted-foreground">
                Key name
              </Label>
              <Input
                id="apikey-name"
                className="h-8 text-[13px]"
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
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={cancelCreate}>
                Cancel
              </Button>
              <Button
                size="sm"
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
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2.5 py-3 text-[13px] text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
            <span>Loading API keys...</span>
          </div>
        ) : keys.length === 0 && !hasInlineContent ? (
          <div className="flex items-center gap-3 py-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Shield size={20} />
            </div>
            <p className="text-[13px] text-muted-foreground">
              No API keys yet. Create one to start sending data from your apps.
            </p>
          </div>
        ) : keys.length > 0 ? (
          <div className="grid gap-2.5">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/40"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Key size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[13px] font-medium text-foreground">{k.name}</p>
                      <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {k.prefix}...••••••••
                      </code>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      Created {formatDate(k.created_at)} · Last used {formatRelativeTime(k.last_used_at)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setRevokeTarget(k)}
                    aria-label={`Revoke ${k.name}`}
                  >
                    <Trash2 size={14} />
                    Revoke
                  </Button>
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
