"use client";

import { Check, X } from "lucide-react";

interface PasswordStrengthMeterProps {
  password: string;
}

interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  color: string;
}

const COMMON_PATTERNS = [
  /^password/i,
  /^qwerty/i,
  /^abc/i,
  /^123/,
  /^letmein/i,
  /^welcome/i,
  /^admin/i,
];

function score(pw: string): StrengthResult {
  if (!pw) return { score: 0, label: "", color: "#e5e7eb" };

  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;

  // Penalties
  if (pw.length < 8) s = Math.min(s, 1);
  if (COMMON_PATTERNS.some((re) => re.test(pw))) s = Math.min(s, 1);
  if (/^(.)\1+$/.test(pw)) s = 0; // all same char

  const clamped = Math.max(0, Math.min(4, s)) as 0 | 1 | 2 | 3 | 4;
  const meta = [
    { label: "Too weak", color: "#dc2626" },
    { label: "Weak", color: "#f59e0b" },
    { label: "Fair", color: "#eab308" },
    { label: "Good", color: "#16a34a" },
    { label: "Strong", color: "#15803d" },
  ][clamped];
  return { score: clamped, label: meta.label, color: meta.color };
}

export default function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  if (!password) return null;

  const { score: s, label, color } = score(password);
  const checks = [
    { ok: password.length >= 8, label: "At least 8 characters" },
    { ok: /[A-Z]/.test(password) && /[a-z]/.test(password), label: "Upper and lowercase letters" },
    { ok: /\d/.test(password), label: "At least one number" },
    { ok: /[^A-Za-z0-9]/.test(password), label: "At least one symbol" },
  ];

  return (
    <div style={{ marginTop: "8px" }} aria-live="polite">
      <div style={{ display: "flex", gap: "4px", marginBottom: "6px" }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: "4px",
              borderRadius: "2px",
              background: i < s ? color : "#e5e7eb",
              transition: "background 150ms ease",
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: "12px", color, fontWeight: 500, marginBottom: "6px" }}>
        {label}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "2px" }}>
        {checks.map((c, i) => (
          <li
            key={i}
            style={{
              fontSize: "12px",
              color: c.ok ? "#16a34a" : "#6b7280",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {c.ok ? <Check size={12} /> : <X size={12} />}
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
