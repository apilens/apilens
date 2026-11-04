"use client";

/**
 * "Keep me signed in" (#322): checked asks identity for the long session (30 days) and gives the
 * session cookie a 30-day max-age; unchecked keeps both to 24 hours. Sent as `remember` to the
 * sign-in Route Handlers (`/api/auth/email/verify`, and through the pre-auth cookie to
 * `/api/auth/2fa/exchange`). Shared by `/verify` and the 2FA step.
 */
export function KeepSignedIn({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ob-keep">
      <input type="checkbox" name="remember" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Keep me signed in
        <small>{checked ? "For 30 days on this device." : "For 24 hours, then sign in again."}</small>
      </span>
    </label>
  );
}
