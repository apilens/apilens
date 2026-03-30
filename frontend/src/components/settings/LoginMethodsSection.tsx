"use client";

import { useState, useEffect } from "react";
import { Mail, Lock, Eye, EyeOff, Fingerprint, Trash2, Loader2 } from "lucide-react";
import { isPasskeySupported, registerPasskey, credentialToJSON } from "@/lib/webauthn";
import SettingsCard from "./SettingsCard";

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
  const [isAddingPasskey, setIsAddingPasskey] = useState(false);
  const [passkeyError, setPasskeyError] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [showAddPasskey, setShowAddPasskey] = useState(false);

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
    setPasskeyError("");
    setIsAddingPasskey(true);

    try {
      // Get registration options from server
      console.log("Fetching passkey registration options...");
      const optionsResponse = await fetch("/api/account/passkeys/register/options", {
        method: "POST",
      });

      console.log("Options response status:", optionsResponse.status);
      console.log("Options response headers:", Object.fromEntries(optionsResponse.headers.entries()));

      if (!optionsResponse.ok) {
        const responseText = await optionsResponse.text();
        console.error("Failed response text:", responseText);

        let data;
        try {
          data = JSON.parse(responseText);
        } catch {
          data = { error: responseText || "Failed to start passkey registration" };
        }

        console.error("Failed to get options:", data);
        const errorMessage = typeof data.error === 'string' ? data.error : "Failed to start passkey registration";
        throw new Error(errorMessage);
      }

      const options = await optionsResponse.json();
      console.log("Got options:", options);
      console.log("Challenge from server:", options.publicKey.challenge);

      // Store the original challenge before registerPasskey
      const originalChallenge = options.publicKey.challenge;

      // Prompt user to create passkey
      console.log("Calling registerPasskey...");
      const credential = await registerPasskey(options);
      console.log("Got credential:", credential);

      const credentialJSON = credentialToJSON(credential);
      console.log("Credential JSON:", credentialJSON);

      // Verify and save the passkey
      console.log("Sending challenge to verify:", originalChallenge);
      const verifyResponse = await fetch("/api/account/passkeys/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credential: credentialJSON,
          challenge: originalChallenge,
          device_name: deviceName || "My Device",
        }),
      });

      if (!verifyResponse.ok) {
        const data = await verifyResponse.json();
        throw new Error(data.error || "Failed to verify passkey");
      }

      // Success - refresh the list
      await fetchPasskeys();
      setShowAddPasskey(false);
      setDeviceName("");
    } catch (err) {
      console.error("Passkey registration error:", err);
      let errorMessage = "Failed to add passkey";

      if (err instanceof Error) {
        errorMessage = err.message;
      } else if (typeof err === "string") {
        errorMessage = err;
      } else if (err && typeof err === "object" && "message" in err) {
        errorMessage = String((err as any).message);
      }

      setPasskeyError(errorMessage);
    } finally {
      setIsAddingPasskey(false);
    }
  };

  const handleDeletePasskey = async (passkeyId: string) => {
    if (!confirm("Are you sure you want to delete this passkey?")) return;

    try {
      const response = await fetch(`/api/account/passkeys/${passkeyId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete passkey");
      }

      await fetchPasskeys();
    } catch (err) {
      alert("Failed to delete passkey");
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
            <p className="login-method-name">Email</p>
            <p className="login-method-detail">{email || "Magic link sign in"}</p>
          </div>
          <span className="login-method-badge login-method-badge-active">Active</span>
        </div>

        <div className="login-method-item-wrapper">
          <div className="login-method-item">
            <div className="login-method-icon">
              <Lock size={16} />
            </div>
            <div className="login-method-info">
              <p className="login-method-name">Password</p>
              <p className="login-method-detail">
                {hasPassword ? "Password sign in enabled" : "Set a password for your account"}
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
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                  >
                    {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <div className="password-field">
                <label className="password-label">Confirm new password</label>
                <div className="password-input-wrapper">
                  <input
                    type={showConfirmPassword ? "text" : "password"}
                    className="password-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  >
                    {showConfirmPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {error && <p className="password-error">{error}</p>}

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
                    ? `${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"} registered`
                    : "Use your fingerprint, face, or device PIN"}
                </p>
              </div>
              {!showAddPasskey && (
                <button
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => setShowAddPasskey(true)}
                >
                  Add passkey
                </button>
              )}
            </div>

            {showAddPasskey && (
              <form className="password-form" onSubmit={handleAddPasskey}>
                <p className="password-label" style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "8px" }}>
                  💡 <strong>Tip:</strong> If you already have a passkey on this device, it will sync automatically via iCloud Keychain (iOS/macOS) or Google Password Manager (Android). Only register a new one if you want a device-specific passkey.
                </p>

                <div className="password-field">
                  <label className="password-label">Device name (optional)</label>
                  <input
                    type="text"
                    className="password-input"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="e.g., iPhone, MacBook, Work Laptop"
                  />
                </div>

                {passkeyError && <p className="password-error">{passkeyError}</p>}

                <div className="password-actions">
                  <button
                    type="button"
                    className="settings-btn settings-btn-secondary settings-btn-sm"
                    onClick={() => {
                      setShowAddPasskey(false);
                      setDeviceName("");
                      setPasskeyError("");
                    }}
                    disabled={isAddingPasskey}
                  >
                    Cancel
                  </button>
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
                      "Add passkey"
                    )}
                  </button>
                </div>
              </form>
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
                      onClick={() => handleDeletePasskey(passkey.id)}
                      title="Delete passkey"
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
    </SettingsCard>
  );
}
