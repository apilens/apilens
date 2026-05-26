"use client";

import { useState, useEffect } from "react";
import { Mail, Lock, Eye, EyeOff, Fingerprint, Trash2, Loader2 } from "lucide-react";
import { isPasskeySupported, getBiometricLabel, detectDeviceName } from "@/lib/webauthn";
import { useAddPasskey } from "@/hooks/useAddPasskey";
import SettingsCard from "./SettingsCard";
import ConfirmDialog from "./ConfirmDialog";
import PasswordStrengthMeter from "./PasswordStrengthMeter";
import Skeleton from "@/components/ui/Skeleton";

interface PasskeyCredential {
  id: string;
  device_name: string;
  created_at: string;
  last_used_at: string | null;
}

interface LoginMethodsSectionProps {
  email?: string;
  hasPassword?: boolean;
  onSetPassword?: (data: {
    new_password: string;
    confirm_password: string;
    current_password?: string;
  }) => Promise<void>;
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
    </svg>
  );
}

export default function LoginMethodsSection({ email, hasPassword, onSetPassword }: LoginMethodsSectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Passkey state
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyCredential[]>([]);
  const [isLoadingPasskeys, setIsLoadingPasskeys] = useState(false);
  const [passkeyError, setPasskeyError] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [showAddPasskey, setShowAddPasskey] = useState(false);
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState<PasskeyCredential | null>(null);
  const [isDeletingPasskey, setIsDeletingPasskey] = useState(false);

  const biometricLabel = getBiometricLabel();
  const [passkeyInfo, setPasskeyInfo] = useState("");

  const { addPasskey, isAdding: isAddingPasskey } = useAddPasskey({
    onSuccess: async () => {
      await fetchPasskeys();
      setShowAddPasskey(false);
      setDeviceName("");
      setPasskeyError("");
      setPasskeyInfo("");
    },
    onAlreadyRegistered: (msg) => {
      // Device already has a passkey for this site (e.g. synced via iCloud
      // Keychain). Not an error — show a friendly info note.
      setPasskeyError("");
      setPasskeyInfo(msg);
    },
    onCancelled: () => {
      // User dismissed the OS prompt — quietly reset, no error noise.
      setPasskeyError("");
      setPasskeyInfo("");
    },
    onError: (msg) => {
      setPasskeyInfo("");
      setPasskeyError(msg);
    },
  });

  // Check passkey support on mount
  useEffect(() => {
    void isPasskeySupported().then((supported) => {
      setPasskeySupported(supported);
      if (supported) {
        void fetchPasskeys();
      }
    });
  }, []);

  const fetchPasskeys = async () => {
    setIsLoadingPasskeys(true);
    try {
      const response = await fetch("/api/account/passkeys");
      if (response.ok) {
        const data = await response.json();
        setPasskeys(data.passkeys || []);
      }
    } catch (err) {
      console.error("Failed to fetch passkeys:", err);
    } finally {
      setIsLoadingPasskeys(false);
    }
  };

  const handleAddPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    await addPasskey(deviceName);
  };

  const doDeletePasskey = async () => {
    if (!confirmDeletePasskey) return;
    setIsDeletingPasskey(true);
    try {
      const response = await fetch(`/api/account/passkeys/${confirmDeletePasskey.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to delete passkey");
      }
      await fetchPasskeys();
      setConfirmDeletePasskey(null);
    } catch (err) {
      setPasskeyError("Failed to delete passkey");
    } finally {
      setIsDeletingPasskey(false);
    }
  };

  const resetForm = () => {
    setNewPassword("");
    setConfirmPassword("");
    setCurrentPassword("");
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setShowCurrentPassword(false);
    setError("");
    setIsSubmitting(false);
  };

  const handleCancel = () => {
    resetForm();
    setShowForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (hasPassword && !currentPassword) {
      setError("Current password is required");
      return;
    }

    if (!onSetPassword) return;

    setIsSubmitting(true);
    try {
      await onSetPassword({
        new_password: newPassword,
        confirm_password: confirmPassword,
        ...(hasPassword ? { current_password: currentPassword } : {}),
      });
      resetForm();
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set password");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SettingsCard
      title="Login Methods"
      description="How you sign in to your account"
    >
      <div className="login-methods">
        <div className="login-method-item">
          <div className="login-method-icon">
            <Mail size={16} />
          </div>
          <div className="login-method-info">
            <p className="login-method-name">Email · Magic link</p>
            <p className="login-method-detail">
              {email || "—"} · We email you a one-tap link when you sign in.
            </p>
          </div>
          <span className="login-method-badge login-method-badge-active">Always on</span>
        </div>

        <div className="login-method-item-wrapper">
          <div className="login-method-item">
            <div className="login-method-icon">
              <Lock size={16} />
            </div>
            <div className="login-method-info">
              <p className="login-method-name">Password</p>
              <p className="login-method-detail">
                {hasPassword
                  ? "Reliable fallback when you can't get to your passkey."
                  : "Optional — useful as a backup if your passkey isn't available."}
              </p>
            </div>
            {!showForm && (
              <>
                {/*<span className={`login-method-badge ${hasPassword ? "login-method-badge-active" : "login-method-badge-inactive"}`}>*/}
                {/*  {hasPassword ? "Active" : "Not set"}*/}
                {/*</span>*/}
                <button
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => setShowForm(true)}
                >
                  {hasPassword ? "Change password" : "Set password"}
                </button>
              </>
            )}
          </div>

          {showForm && (
            <form className="password-form" onSubmit={handleSubmit}>
              {hasPassword && (
                <div className="password-field">
                  <label className="password-label">Current password</label>
                  <div className="password-input-wrapper">
                    <input
                      type={showCurrentPassword ? "text" : "password"}
                      className="password-input"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Enter current password"
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                    >
                      {showCurrentPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              )}

              <div className="password-field">
                <label className="password-label">New password</label>
                <div className="password-input-wrapper">
                  <input
                    type={showNewPassword ? "text" : "password"}
                    className="password-input"
                    value={newPassword}
                    onChange={(e) => {
                      setNewPassword(e.target.value);
                      if (error === "Passwords do not match") setError("");
                    }}
                    placeholder="Enter new password"
                    autoComplete="new-password"
                    aria-invalid={
                      confirmPassword.length > 0 && newPassword !== confirmPassword
                    }
                    style={
                      confirmPassword.length > 0 && newPassword !== confirmPassword
                        ? { borderColor: "var(--danger, #dc2626)" }
                        : undefined
                    }
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                  >
                    {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <PasswordStrengthMeter password={newPassword} />
              </div>

              <div className="password-field">
                <label className="password-label">Confirm new password</label>
                <div className="password-input-wrapper">
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    className="password-input"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (error === "Passwords do not match") setError("");
                    }}
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                    aria-invalid={
                      confirmPassword.length > 0 && newPassword !== confirmPassword
                    }
                    style={
                      confirmPassword.length > 0 && newPassword !== confirmPassword
                        ? { borderColor: "var(--danger, #dc2626)" }
                        : undefined
                    }
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    {showConfirmPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {confirmPassword.length > 0 && newPassword !== confirmPassword && (
                  <p
                    className="password-error"
                    style={{ marginTop: "4px" }}
                  >
                    Passwords don't match yet.
                  </p>
                )}
              </div>

              {error && error !== "Passwords do not match" && (
                <p className="password-error">{error}</p>
              )}

              <div className="password-actions">
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={handleCancel}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="settings-btn settings-btn-primary settings-btn-sm"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Saving..." : hasPassword ? "Update password" : "Set password"}
                </button>
              </div>
            </form>
          )}
        </div>

        {passkeySupported && (
          <div className="login-method-item-wrapper">
            <div className="login-method-item">
              <div className="login-method-icon">
                <Fingerprint size={16} />
              </div>
              <div className="login-method-info">
                <p className="login-method-name">Passkeys</p>
                <p className="login-method-detail">
                  {passkeys.length > 0
                    ? `${passkeys.length} registered · Fastest and most secure sign-in.`
                    : `Sign in instantly with ${biometricLabel}. No password needed.`}
                </p>
              </div>
              {!showAddPasskey && (
                <button
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => setShowAddPasskey(true)}
                >
                  Add {biometricLabel}
                </button>
              )}
            </div>

            {showAddPasskey && (
              <form className="password-form" onSubmit={handleAddPasskey}>
                <div className="password-field">
                  <label className="password-label">Device name (optional)</label>
                  <input
                    type="text"
                    className="password-input"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder={detectDeviceName()}
                  />
                  <p
                    style={{
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      marginTop: "4px",
                      lineHeight: 1.4,
                    }}
                  >
                    You'll be prompted for {biometricLabel} when you continue.
                  </p>
                </div>

                {passkeyError && <p className="password-error">{passkeyError}</p>}
                {passkeyInfo && (
                  <div
                    style={{
                      padding: "12px 14px",
                      background: "#eff6ff",
                      border: "1px solid #bfdbfe",
                      borderRadius: "8px",
                      fontSize: "13px",
                      color: "#1e3a8a",
                      lineHeight: "1.5",
                    }}
                    role="status"
                  >
                    {passkeyInfo}
                  </div>
                )}

                <div className="password-actions">
                  <button
                    type="button"
                    className="settings-btn settings-btn-secondary settings-btn-sm"
                    onClick={() => {
                      setShowAddPasskey(false);
                      setDeviceName("");
                      setPasskeyError("");
                      setPasskeyInfo("");
                    }}
                    disabled={isAddingPasskey}
                  >
                    {passkeyInfo ? "Close" : "Cancel"}
                  </button>
                  {!passkeyInfo && (
                    <button
                      type="submit"
                      className="settings-btn settings-btn-primary settings-btn-sm"
                      disabled={isAddingPasskey}
                    >
                      {isAddingPasskey ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Adding...
                        </>
                      ) : (
                        `Set up ${biometricLabel}`
                      )}
                    </button>
                  )}
                </div>
              </form>
            )}

            {isLoadingPasskeys && passkeys.length === 0 && (
              <div className="passkeys-list" aria-busy="true">
                {[0, 1].map((i) => (
                  <div key={i} className="passkey-item" style={{ pointerEvents: "none" }}>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
                      <Skeleton variant="line" width="50%" height={12} />
                      <Skeleton variant="line" width="70%" height={10} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {passkeys.length > 0 && (
              <div className="passkeys-list">
                {passkeys.map((passkey) => (
                  <div key={passkey.id} className="passkey-item">
                    <div className="passkey-info">
                      <p className="passkey-name">
                        <Fingerprint size={14} />
                        {passkey.device_name}
                      </p>
                      <p className="passkey-detail">
                        Added {new Date(passkey.created_at).toLocaleDateString()}
                        {passkey.last_used_at && ` • Last used ${new Date(passkey.last_used_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <button
                      className="passkey-delete-btn"
                      onClick={() => setConfirmDeletePasskey(passkey)}
                      title="Delete passkey"
                      aria-label={`Delete passkey ${passkey.device_name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="login-method-item">
          <div className="login-method-icon">
            <GoogleIcon />
          </div>
          <div className="login-method-info">
            <p className="login-method-name">Google</p>
            <p className="login-method-detail">Sign in with Google</p>
          </div>
          <span className="login-method-badge login-method-badge-soon">Coming soon</span>
        </div>

        <div className="login-method-item">
          <div className="login-method-icon">
            <AppleIcon />
          </div>
          <div className="login-method-info">
            <p className="login-method-name">Apple</p>
            <p className="login-method-detail">Sign in with Apple</p>
          </div>
          <span className="login-method-badge login-method-badge-soon">Coming soon</span>
        </div>
      </div>

      <ConfirmDialog
        isOpen={!!confirmDeletePasskey}
        onClose={() => setConfirmDeletePasskey(null)}
        onConfirm={doDeletePasskey}
        title="Delete passkey?"
        description={
          confirmDeletePasskey
            ? `"${confirmDeletePasskey.device_name}" will be removed. You won't be able to sign in with this passkey anymore.`
            : ""
        }
        confirmText="Delete passkey"
        variant="danger"
        isLoading={isDeletingPasskey}
      />
    </SettingsCard>
  );
}
