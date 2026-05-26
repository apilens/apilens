"use client";

import { useState, useEffect } from "react";
import { Trash2, X, AlertTriangle, Loader2 } from "lucide-react";
import SettingsCard from "./SettingsCard";

interface DangerZoneSectionProps {
  onDeleteAccount: () => Promise<void>;
}

interface AccountFootprint {
  apiKeys: number;
  passkeys: number;
  sessions: number;
}

/**
 * Fetches a quick snapshot of what'll be erased when the user deletes their
 * account so the confirm modal can show concrete numbers ("4 API keys, 2
 * passkeys, 3 sessions") instead of vague copy. Small parallel requests, only
 * fired when the user opens the modal.
 */
async function fetchFootprint(): Promise<AccountFootprint> {
  const get = async (url: string): Promise<unknown[]> => {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return data.keys || data.passkeys || data.sessions || [];
  };
  const [apiKeys, passkeys, sessions] = await Promise.all([
    get("/api/account/api-keys"),
    get("/api/account/passkeys"),
    get("/api/account/sessions"),
  ]);
  return {
    apiKeys: apiKeys.length,
    passkeys: passkeys.length,
    sessions: sessions.length,
  };
}

export default function DangerZoneSection({ onDeleteAccount }: DangerZoneSectionProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [typedWord, setTypedWord] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [footprint, setFootprint] = useState<AccountFootprint | null>(null);
  const [isLoadingFootprint, setIsLoadingFootprint] = useState(false);

  // Lazily load the counts when the modal opens.
  useEffect(() => {
    if (!showConfirm) return;
    setIsLoadingFootprint(true);
    fetchFootprint()
      .then(setFootprint)
      .catch(() => setFootprint({ apiKeys: 0, passkeys: 0, sessions: 0 }))
      .finally(() => setIsLoadingFootprint(false));
  }, [showConfirm]);

  // Reset modal state when it closes.
  useEffect(() => {
    if (!showConfirm) {
      setTypedWord("");
      setAcknowledged(false);
      setFootprint(null);
    }
  }, [showConfirm]);

  const canDelete = acknowledged && typedWord === "DELETE" && !isDeleting;

  const handleDelete = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteAccount();
      // Parent handler logs out and redirects on success — no further work here.
    } finally {
      setIsDeleting(false);
    }
  };

  // Build the bulleted list of what's about to disappear. Always include the
  // baseline items even when counts are 0 so the user sees the full scope.
  const buildFootprintItems = () => {
    if (!footprint) return null;
    const lines: string[] = [];
    lines.push("Your profile and email");
    if (footprint.apiKeys > 0) {
      lines.push(`${footprint.apiKeys} API key${footprint.apiKeys === 1 ? "" : "s"} (any integrations using them will break immediately)`);
    } else {
      lines.push("Any API keys you create later");
    }
    if (footprint.passkeys > 0) {
      lines.push(`${footprint.passkeys} passkey${footprint.passkeys === 1 ? "" : "s"}`);
    }
    if (footprint.sessions > 0) {
      lines.push(`${footprint.sessions} active session${footprint.sessions === 1 ? "" : "s"}`);
    }
    lines.push("All projects, apps, and observability data");
    return lines;
  };

  const items = buildFootprintItems();

  return (
    <>
      <SettingsCard
        title="Danger Zone"
        description="Irreversible actions for your account"
        variant="danger"
      >
        <div className="danger-zone-content">
          <div className="danger-zone-item">
            <div className="danger-zone-info">
              <p className="danger-zone-label">Delete Account</p>
              <p className="danger-zone-description">
                Permanently delete your account and all data we hold about you. There's no undo.
              </p>
            </div>
            <button
              className="settings-btn settings-btn-danger"
              onClick={() => setShowConfirm(true)}
            >
              <Trash2 size={14} />
              Delete account
            </button>
          </div>
        </div>
      </SettingsCard>

      {showConfirm && (
        <div className="dialog-overlay">
          <div className="dialog-content" style={{ maxWidth: "480px" }}>
            <button
              className="dialog-close"
              onClick={() => !isDeleting && setShowConfirm(false)}
              disabled={isDeleting}
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>

            <div className="dialog-header">
              <div className="dialog-icon-danger">
                <AlertTriangle size={24} />
              </div>
              <h3 className="dialog-title">Permanently delete your account?</h3>
              <p className="dialog-description">
                The following data will be erased — this cannot be undone.
              </p>
            </div>

            <div style={{ padding: "0 24px 16px" }}>
              {isLoadingFootprint ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    color: "var(--text-secondary)",
                    fontSize: "13px",
                    padding: "12px 0",
                  }}
                >
                  <Loader2 size={14} className="animate-spin" />
                  Calculating what will be removed…
                </div>
              ) : items ? (
                <ul
                  style={{
                    margin: 0,
                    padding: "12px 16px",
                    background: "rgba(255, 68, 68, 0.05)",
                    border: "1px solid rgba(255, 68, 68, 0.2)",
                    borderRadius: "8px",
                    listStyle: "disc",
                    listStylePosition: "inside",
                    fontSize: "13px",
                    lineHeight: 1.7,
                    color: "var(--text-primary)",
                  }}
                >
                  {items.map((it, i) => (
                    <li key={i}>{it}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="dialog-input-section">
              <label
                style={{
                  display: "flex",
                  gap: "10px",
                  alignItems: "flex-start",
                  cursor: "pointer",
                  fontSize: "13px",
                  lineHeight: 1.5,
                  color: "var(--text-primary)",
                }}
              >
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  disabled={isDeleting}
                  style={{
                    marginTop: "2px",
                    width: "16px",
                    height: "16px",
                    flexShrink: 0,
                    cursor: "pointer",
                  }}
                />
                <span>
                  I understand this cannot be undone, and I've copied any data I need to keep.
                </span>
              </label>

              <div style={{ marginTop: "16px", opacity: acknowledged ? 1 : 0.4, transition: "opacity 0.15s" }}>
                <label
                  className="dialog-input-label"
                  htmlFor="delete-confirm-word"
                >
                  Type <code style={{ background: "var(--bg-tertiary)", padding: "1px 6px", borderRadius: "4px", fontFamily: "monospace", fontWeight: 600 }}>DELETE</code> to confirm
                </label>
                <input
                  id="delete-confirm-word"
                  className="dialog-input"
                  type="text"
                  value={typedWord}
                  onChange={(e) => setTypedWord(e.target.value)}
                  placeholder="DELETE"
                  disabled={!acknowledged || isDeleting}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="dialog-footer">
              <button
                className="settings-btn settings-btn-secondary"
                onClick={() => setShowConfirm(false)}
                disabled={isDeleting}
              >
                Keep my account
              </button>
              <button
                className="settings-btn settings-btn-danger"
                onClick={handleDelete}
                disabled={!canDelete}
              >
                {isDeleting ? (
                  <span className="btn-loading">
                    <span className="btn-spinner" />
                    Deleting…
                  </span>
                ) : (
                  "Permanently delete account"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
