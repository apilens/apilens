"use client";

import { useState, useEffect } from "react";
import { Shield, Key, Copy, Check, AlertTriangle, Loader2 } from "lucide-react";
import QRCode from "qrcode";
import SettingsCard from "./SettingsCard";

export default function TwoFactorSection() {
  const [enabled, setEnabled] = useState(false);
  const [backupCodesRemaining, setBackupCodesRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [verifyCode, setVerifyCode] = useState(["", "", "", "", "", ""]);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await fetch("/api/account/2fa/status");
      if (response.ok) {
        const data = await response.json();
        setEnabled(data.enabled);
        setBackupCodesRemaining(data.backup_codes_remaining);
      }
    } catch (err) {
      console.error("Failed to fetch 2FA status:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async () => {
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/account/2fa/enable", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to enable 2FA");
      }

      const data = await response.json();
      setSecret(data.secret);

      const qrDataUrl = await QRCode.toDataURL(data.qr_code_uri, {
        width: 256,
        margin: 2,
      });
      setQrCodeUrl(qrDataUrl);
      setShowSetup(true);
    } catch (err: any) {
      setError(err.message || "Failed to enable 2FA");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    const code = verifyCode.join("");
    if (!code || code.length !== 6) {
      setError("Please enter a 6-digit code");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/account/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Invalid code");
      }

      const data = await response.json();
      setBackupCodes(data.codes);
      setEnabled(true);
      setVerifyCode(["", "", "", "", "", ""]);
      setShowSetup(false);
    } catch (err: any) {
      setError(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return; // Only digits

    const newCode = [...verifyCode];
    newCode[index] = value.slice(-1); // Only last digit
    setVerifyCode(newCode);
    setError("");

    // Auto-focus next input
    if (value && index < 5) {
      const nextInput = document.getElementById(`otp-${index + 1}`);
      nextInput?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !verifyCode[index] && index > 0) {
      const prevInput = document.getElementById(`otp-${index - 1}`);
      prevInput?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const newCode = [...verifyCode];

    for (let i = 0; i < pastedData.length; i++) {
      newCode[i] = pastedData[i];
    }

    setVerifyCode(newCode);

    // Focus last filled input or first empty
    const focusIndex = Math.min(pastedData.length, 5);
    const input = document.getElementById(`otp-${focusIndex}`);
    input?.focus();
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  };

  const handleDisable = async () => {
    if (!confirm("Are you sure you want to disable two-factor authentication?")) {
      return;
    }

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/account/2fa/disable", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to disable 2FA");
      }

      setEnabled(false);
      setBackupCodesRemaining(0);
      setBackupCodes([]);
    } catch (err: any) {
      setError(err.message || "Failed to disable 2FA");
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerateBackupCodes = async () => {
    if (!confirm("This will invalidate your existing backup codes. Continue?")) {
      return;
    }

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/account/2fa/backup-codes/regenerate", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to regenerate backup codes");
      }

      const data = await response.json();
      setBackupCodes(data.codes);
      setBackupCodesRemaining(data.codes.length);
    } catch (err: any) {
      setError(err.message || "Failed to regenerate backup codes");
    } finally {
      setLoading(false);
    }
  };

  const copyCode = (code: string, index: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const downloadBackupCodes = () => {
    const text = backupCodes.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "apilens-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !enabled && !showSetup) {
    return (
      <SettingsCard title="Two-Factor Authentication" description="Loading...">
        <div />
      </SettingsCard>
    );
  }

  return (
    <>
      {!backupCodes.length && (
        <SettingsCard
          title="Two-Factor Authentication"
          description="Add an extra layer of security with TOTP authenticator apps"
        >
          {error && (
            <div className="form-error" style={{ marginBottom: "16px" }}>
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          {!enabled && !showSetup && (
          <div className="login-methods">
            <div className="login-method-item">
              <div className="login-method-icon">
                <Shield size={16} />
              </div>
              <div className="login-method-info">
                <p className="login-method-name">Authenticator App (TOTP)</p>
                <p className="login-method-detail">Add extra security with time-based codes</p>
              </div>
              <button
                onClick={handleEnable}
                disabled={loading}
                className="settings-btn settings-btn-secondary settings-btn-sm"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : "Enable"}
              </button>
            </div>
          </div>
        )}

        {showSetup && !enabled && (
          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: "28px",
            padding: "4px 0"
          }}>
            {/* QR Code Section */}
            <div>
              <label className="password-label" style={{ marginBottom: "12px", display: "block" }}>
                Scan with Authenticator App
              </label>
              <p className="login-method-detail" style={{ marginBottom: "20px", lineHeight: "1.5" }}>
                Use Google Authenticator, Authy, or 1Password
              </p>

              {qrCodeUrl && (
                <div style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  padding: "28px",
                  background: "#ffffff",
                  borderRadius: "12px",
                  border: "1px solid var(--border-color)",
                  marginBottom: "16px"
                }}>
                  <img
                    src={qrCodeUrl}
                    alt="QR Code"
                    style={{
                      width: "220px",
                      height: "220px",
                      display: "block"
                    }}
                  />
                </div>
              )}

              {/* Manual Entry Code */}
              <div style={{
                padding: "14px 16px",
                background: "var(--bg-secondary)",
                borderRadius: "8px",
                border: "1px solid var(--border-color)"
              }}>
                <div style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "12px"
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                      marginBottom: "8px",
                      fontWeight: "500"
                    }}>
                      Can't scan? Enter this code manually:
                    </p>
                    <code style={{
                      fontSize: "13px",
                      fontFamily: "monospace",
                      color: "var(--text-primary)",
                      wordBreak: "break-all",
                      display: "block",
                      lineHeight: "1.6"
                    }}>
                      {secret}
                    </code>
                  </div>
                  <button
                    onClick={copySecret}
                    style={{
                      background: "var(--bg-hover)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "6px",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      padding: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      transition: "all 0.15s ease",
                      minWidth: "36px",
                      height: "36px"
                    }}
                    title="Copy code"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-active)";
                      e.currentTarget.style.borderColor = "var(--border-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.borderColor = "var(--border-color)";
                    }}
                  >
                    {copiedSecret ? (
                      <Check size={16} style={{ color: "#22c55e" }} />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Verification Code Section */}
            <div>
              <label className="password-label" style={{ marginBottom: "12px", display: "block" }}>
                Enter 6-Digit Code
              </label>
              <div style={{
                display: "flex",
                gap: "10px",
                justifyContent: "flex-start",
                alignItems: "center"
              }}>
                {verifyCode.map((digit, index) => (
                  <input
                    key={index}
                    id={`otp-${index}`}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(index, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(index, e)}
                    onPaste={index === 0 ? handleOtpPaste : undefined}
                    className="password-input"
                    style={{
                      width: "52px",
                      height: "60px",
                      textAlign: "center",
                      fontSize: "28px",
                      fontWeight: "600",
                      fontFamily: "monospace",
                      padding: "0",
                      letterSpacing: "0"
                    }}
                    autoFocus={index === 0}
                  />
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="password-actions" style={{ marginTop: "4px" }}>
              <button
                type="button"
                onClick={handleVerify}
                disabled={loading || verifyCode.join("").length !== 6}
                className="settings-btn settings-btn-primary"
              >
                {loading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify & Enable"
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSetup(false);
                  setQrCodeUrl("");
                  setSecret("");
                  setVerifyCode(["", "", "", "", "", ""]);
                  setError("");
                }}
                className="settings-btn settings-btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {enabled && !backupCodes.length && (
          <div className="login-methods">
            <div className="login-method-item">
              <div className="login-method-icon" style={{ color: "var(--accent)" }}>
                <Shield size={16} />
              </div>
              <div className="login-method-info">
                <p className="login-method-name">Two-Factor Authentication</p>
                <p className="login-method-detail">
                  Active • {backupCodesRemaining} backup codes remaining
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={handleRegenerateBackupCodes}
                  disabled={loading}
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                >
                  Backup Codes
                </button>
                <button
                  onClick={handleDisable}
                  disabled={loading}
                  className="settings-btn settings-btn-danger settings-btn-sm"
                >
                  Disable
                </button>
              </div>
            </div>
          </div>
        )}
        </SettingsCard>
      )}

      {backupCodes.length > 0 && (
        <SettingsCard
          title="Save Your Backup Codes"
          description="Store these codes safely. Each code can be used once if you lose access to your authenticator."
        >
          <div style={{
            padding: "14px 16px",
            background: "#fffbeb",
            border: "1px solid #fbbf24",
            borderRadius: "8px",
            marginBottom: "20px"
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "6px"
            }}>
              <AlertTriangle size={18} style={{ color: "#f59e0b", flexShrink: 0 }} />
              <strong style={{ fontSize: "14px", color: "#92400e", fontWeight: 600 }}>
                Important: Save These Codes
              </strong>
            </div>
            <p style={{
              fontSize: "13px",
              color: "#92400e",
              margin: 0,
              lineHeight: "1.5",
              paddingLeft: "28px"
            }}>
              You won't be able to see them again. Download or copy them to a safe location.
            </p>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: "12px",
            marginBottom: "20px"
          }}>
            {backupCodes.map((code, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 14px",
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  gap: "12px"
                }}
              >
                <code style={{
                  fontSize: "14px",
                  fontFamily: "monospace",
                  color: "var(--text-primary)",
                  fontWeight: 500,
                  letterSpacing: "0.5px"
                }}>
                  {code}
                </code>
                <button
                  onClick={() => copyCode(code, index)}
                  style={{
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "6px",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    padding: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "all 0.15s ease",
                    minWidth: "28px",
                    height: "28px"
                  }}
                  title="Copy code"
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-active)";
                    e.currentTarget.style.borderColor = "var(--border-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "var(--border-color)";
                  }}
                >
                  {copiedIndex === index ? (
                    <Check size={14} style={{ color: "#22c55e" }} />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <button onClick={downloadBackupCodes} className="settings-btn settings-btn-secondary">
              Download Backup Codes
            </button>
            <button
              onClick={() => {
                setBackupCodes([]);
                fetchStatus();
              }}
              className="settings-btn settings-btn-primary"
            >
              Done
            </button>
          </div>
        </SettingsCard>
      )}
    </>
  );
}
