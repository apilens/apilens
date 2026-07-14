"use client";

import { useState, useEffect } from "react";
import { Shield, Copy, Check, AlertTriangle, Loader2, Eye, EyeOff } from "lucide-react";
import QRCode from "qrcode";
import SettingsCard from "./SettingsCard";
import ConfirmDialog from "./ConfirmDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";
import { Button } from "@/components/reui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/reui/dialog";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";

interface TwoFactorSectionProps {
  hasPassword?: boolean;
}

export default function TwoFactorSection({ hasPassword = false }: TwoFactorSectionProps) {
  const [enabled, setEnabled] = useState(false);
  const [backupCodesRemaining, setBackupCodesRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [verifyCode, setVerifyCode] = useState(["", "", "", "", "", ""]);
  const [enablePassword, setEnablePassword] = useState("");
  const [showEnablePassword, setShowEnablePassword] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [error, setError] = useState("");

  // Disable-2FA modal state
  type DisableMode = "primary" | "backup";
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [disableMode, setDisableMode] = useState<DisableMode>("primary");
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [disableBackupCode, setDisableBackupCode] = useState("");
  const [showDisablePassword, setShowDisablePassword] = useState(false);
  const [disableError, setDisableError] = useState("");
  const [isDisabling, setIsDisabling] = useState(false);

  // Regenerate-backup-codes confirmation
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

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

    if (hasPassword && !enablePassword) {
      setError("Enter your current password to enable 2FA");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/account/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          ...(hasPassword ? { password: enablePassword } : {}),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Invalid code");
      }

      const data = await response.json();
      setBackupCodes(data.codes);
      setEnabled(true);
      setVerifyCode(["", "", "", "", "", ""]);
      setEnablePassword("");
      setShowSetup(false);
    } catch (err: any) {
      setError(err.message || "Verification failed");
      // Reset all 6 digits and refocus the first so the user can immediately
      // retry without manually clearing each box. Keep the password field as-is.
      setVerifyCode(["", "", "", "", "", ""]);
      setTimeout(() => {
        const first = document.getElementById("otp-0") as HTMLInputElement | null;
        first?.focus();
      }, 0);
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

  const openDisableModal = () => {
    setDisableMode("primary");
    setDisablePassword("");
    setDisableCode("");
    setDisableBackupCode("");
    setDisableError("");
    setShowDisablePassword(false);
    setShowDisableModal(true);
  };

  const handleDisable = async () => {
    setDisableError("");

    if (disableMode === "backup") {
      // Backup code is 8 letters/digits, displayed as XXXX-XXXX (9 with dash).
      // Strip non-alphanumerics and require at least 8 chars.
      const cleaned = disableBackupCode.replace(/[^A-Za-z0-9]/g, "");
      if (cleaned.length < 8) {
        setDisableError("Enter a valid backup code");
        return;
      }
    } else if (hasPassword && !disablePassword) {
      setDisableError("Enter your current password");
      return;
    } else if (!hasPassword && (!disableCode || disableCode.length !== 6)) {
      setDisableError("Enter the 6-digit code from your authenticator");
      return;
    }

    setIsDisabling(true);

    try {
      const body: { password?: string; code?: string; backup_code?: string } = {};
      if (disableMode === "backup") body.backup_code = disableBackupCode;
      else if (hasPassword) body.password = disablePassword;
      else body.code = disableCode;

      const response = await fetch("/api/account/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to disable 2FA");
      }

      setEnabled(false);
      setBackupCodesRemaining(0);
      setBackupCodes([]);
      setShowDisableModal(false);
    } catch (err: any) {
      setDisableError(err.message || "Failed to disable 2FA");
    } finally {
      setIsDisabling(false);
    }
  };

  const doRegenerateBackupCodes = async () => {
    setError("");
    setIsRegenerating(true);

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
      setShowRegenerateConfirm(false);
    } catch (err: any) {
      setError(err.message || "Failed to regenerate backup codes");
    } finally {
      setIsRegenerating(false);
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
            <Alert variant="destructive" className="mb-4">
              <AlertTriangle size={14} />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!enabled && !showSetup && (
            <div className="flex items-center gap-3.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Shield size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">Authenticator App (TOTP)</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Add extra security with time-based codes
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleEnable} disabled={loading}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : "Enable"}
              </Button>
            </div>
          )}

          {showSetup && !enabled && (
            <div className="flex flex-col gap-7 py-1">
              {/* QR Code Section */}
              <div>
                <Label className="mb-3 text-[13px]">Scan with Authenticator App</Label>
                <p className="mb-5 text-xs leading-normal text-muted-foreground">
                  Use Google Authenticator, Authy, or 1Password
                </p>

                {qrCodeUrl && (
                  <div className="mb-4 flex items-center justify-center rounded-xl border border-border bg-white p-7">
                    {/* QR stays on a white surface in both themes for scan contrast. */}
                    <img src={qrCodeUrl} alt="QR Code" className="block size-[220px]" />
                  </div>
                )}

                {/* Manual Entry Code */}
                <div className="rounded-lg border border-border bg-muted/50 px-4 py-3.5">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        Can't scan? Enter this code manually:
                      </p>
                      <code className="block break-all font-mono text-[13px] leading-relaxed text-foreground">
                        {secret}
                      </code>
                    </div>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={copySecret}
                      title="Copy code"
                      aria-label="Copy code"
                    >
                      {copiedSecret ? (
                        <Check size={16} className="text-success" />
                      ) : (
                        <Copy size={16} />
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Verification Code Section */}
              <div>
                <Label className="mb-3 text-[13px]">Enter 6-Digit Code</Label>
                <div className="flex flex-nowrap items-center justify-start gap-2.5">
                  {verifyCode.map((digit, index) => (
                    <Input
                      key={index}
                      id={`otp-${index}`}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleOtpChange(index, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(index, e)}
                      onPaste={index === 0 ? handleOtpPaste : undefined}
                      aria-label={`Digit ${index + 1} of 6`}
                      aria-invalid={!!error || undefined}
                      className="h-15 w-13 p-0 text-center font-mono text-[28px]! font-semibold"
                      autoFocus={index === 0}
                    />
                  ))}
                </div>
              </div>

              {/* Password confirmation (only for users with a password) */}
              {hasPassword && (
                <div className="flex max-w-sm flex-col gap-1.5">
                  <Label className="text-[13px]">Confirm with your current password</Label>
                  <div className="relative">
                    <Input
                      type={showEnablePassword ? "text" : "password"}
                      className="pr-9 text-[13px]"
                      value={enablePassword}
                      onChange={(e) => {
                        setEnablePassword(e.target.value);
                        setError("");
                      }}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground outline-none transition-colors hover:text-foreground"
                      onClick={() => setShowEnablePassword(!showEnablePassword)}
                      tabIndex={-1}
                      aria-label={showEnablePassword ? "Hide password" : "Show password"}
                    >
                      {showEnablePassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="mt-1 flex gap-2">
                <Button
                  type="button"
                  onClick={handleVerify}
                  disabled={
                    loading ||
                    verifyCode.join("").length !== 6 ||
                    (hasPassword && !enablePassword)
                  }
                >
                  {loading ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify & Enable"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowSetup(false);
                    setQrCodeUrl("");
                    setSecret("");
                    setVerifyCode(["", "", "", "", "", ""]);
                    setEnablePassword("");
                    setError("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {enabled && !backupCodes.length && (
            <div className="flex flex-col gap-4">
              {backupCodesRemaining < 3 && (
                <Alert variant={backupCodesRemaining === 0 ? "destructive" : "warning"}>
                  <AlertTriangle size={14} />
                  <AlertTitle>
                    {backupCodesRemaining === 0
                      ? "No backup codes left"
                      : `Only ${backupCodesRemaining} backup code${backupCodesRemaining === 1 ? "" : "s"} remaining`}
                  </AlertTitle>
                  <AlertDescription>
                    {backupCodesRemaining === 0
                      ? "If you lose access to your authenticator, you won't be able to sign in. Generate new codes now."
                      : "Generate fresh codes before you run out and save them somewhere safe."}
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex items-center gap-3.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Shield size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-foreground">
                    Two-Factor Authentication
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Active • {backupCodesRemaining} backup codes remaining
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowRegenerateConfirm(true)}
                    disabled={loading}
                  >
                    Backup Codes
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={openDisableModal}
                    disabled={loading}
                  >
                    Disable
                  </Button>
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
          <Alert variant="warning" className="mb-5">
            <AlertTriangle size={18} />
            <AlertTitle>Important: Save These Codes</AlertTitle>
            <AlertDescription>
              You won't be able to see them again. Download or copy them to a safe location.
            </AlertDescription>
          </Alert>

          <div className="mb-5 grid grid-cols-2 gap-3">
            {backupCodes.map((code, index) => (
              <div
                key={index}
                aria-label={`Backup code ${index + 1} of ${backupCodes.length}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 px-3.5 py-3"
              >
                <code className="font-mono text-sm font-medium tracking-wide text-foreground">
                  {code}
                </code>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => copyCode(code, index)}
                  title="Copy code"
                  aria-label={`Copy backup code ${index + 1}`}
                >
                  {copiedIndex === index ? (
                    <Check size={14} className="text-success" />
                  ) : (
                    <Copy size={14} />
                  )}
                </Button>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <Button variant="outline" onClick={downloadBackupCodes}>
              Download Backup Codes
            </Button>
            <Button
              onClick={() => {
                setBackupCodes([]);
                fetchStatus();
              }}
            >
              Done
            </Button>
          </div>
        </SettingsCard>
      )}

      <ConfirmDialog
        isOpen={showRegenerateConfirm}
        onClose={() => setShowRegenerateConfirm(false)}
        onConfirm={doRegenerateBackupCodes}
        title="Regenerate backup codes?"
        description="Your existing backup codes will be invalidated and replaced with new ones. Make sure to save the new codes — they'll only be shown once."
        confirmText="Generate new codes"
        variant="default"
        isLoading={isRegenerating}
      />

      <Dialog
        open={showDisableModal}
        onOpenChange={(open) => {
          if (!open) setShowDisableModal(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle size={20} />
            </div>
            <DialogTitle>Disable two-factor authentication</DialogTitle>
            <DialogDescription>
              {disableMode === "backup"
                ? "Enter one of your backup codes to turn off 2FA. The code will be consumed and your remaining backup codes will be deleted."
                : hasPassword
                ? "Confirm your current password to turn off 2FA. Your backup codes will be deleted."
                : "Enter the current 6-digit code from your authenticator to turn off 2FA. Your backup codes will be deleted."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            {disableMode === "backup" ? (
              <>
                <Label htmlFor="disable-backup-code" className="text-[13px]">
                  Backup code
                </Label>
                <Input
                  id="disable-backup-code"
                  type="text"
                  inputMode="text"
                  maxLength={9}
                  className="font-mono tracking-widest"
                  value={disableBackupCode}
                  onChange={(e) => {
                    setDisableBackupCode(e.target.value.toUpperCase());
                    setDisableError("");
                  }}
                  placeholder="XXXX-XXXX"
                  autoFocus
                />
              </>
            ) : hasPassword ? (
              <>
                <Label htmlFor="disable-password" className="text-[13px]">
                  Current password
                </Label>
                <div className="relative">
                  <Input
                    id="disable-password"
                    type={showDisablePassword ? "text" : "password"}
                    className="pr-9"
                    value={disablePassword}
                    onChange={(e) => {
                      setDisablePassword(e.target.value);
                      setDisableError("");
                    }}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground outline-none transition-colors hover:text-foreground"
                    onClick={() => setShowDisablePassword(!showDisablePassword)}
                    tabIndex={-1}
                    aria-label={showDisablePassword ? "Hide password" : "Show password"}
                  >
                    {showDisablePassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </>
            ) : (
              <>
                <Label htmlFor="disable-code" className="text-[13px]">
                  Authenticator code
                </Label>
                <Input
                  id="disable-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={disableCode}
                  onChange={(e) => {
                    setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                    setDisableError("");
                  }}
                  placeholder="000000"
                  autoFocus
                />
              </>
            )}

            {/* Toggle between primary verification and backup code */}
            <button
              type="button"
              className="mt-1 self-start text-[13px] text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
              onClick={() => {
                setDisableMode(disableMode === "backup" ? "primary" : "backup");
                setDisableError("");
                setDisablePassword("");
                setDisableCode("");
                setDisableBackupCode("");
              }}
            >
              {disableMode === "backup"
                ? hasPassword
                  ? "Use password instead"
                  : "Use authenticator code instead"
                : "Use a backup code instead"}
            </button>

            {disableError && (
              <p className="mt-1 text-xs text-destructive">{disableError}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDisableModal(false)}
              disabled={isDisabling}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisable}
              disabled={
                isDisabling ||
                (disableMode === "backup"
                  ? disableBackupCode.replace(/[^A-Za-z0-9]/g, "").length < 8
                  : hasPassword
                  ? !disablePassword
                  : disableCode.length !== 6)
              }
            >
              {isDisabling ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Disabling...
                </>
              ) : (
                "Disable 2FA"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
