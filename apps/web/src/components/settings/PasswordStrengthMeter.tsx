"use client";

import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface PasswordStrengthMeterProps {
  password: string;
}

interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  colorClass: string;
  barClass: string;
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
  if (!pw) return { score: 0, label: "", colorClass: "text-muted-foreground", barClass: "bg-muted" };

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
    { label: "Too weak", colorClass: "text-destructive", barClass: "bg-destructive" },
    { label: "Weak", colorClass: "text-warning", barClass: "bg-warning" },
    { label: "Fair", colorClass: "text-warning", barClass: "bg-warning" },
    { label: "Good", colorClass: "text-success", barClass: "bg-success" },
    { label: "Strong", colorClass: "text-success", barClass: "bg-success" },
  ][clamped];
  return { score: clamped, label: meta.label, colorClass: meta.colorClass, barClass: meta.barClass };
}

export default function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  if (!password) return null;

  const { score: s, label, colorClass, barClass } = score(password);
  const checks = [
    { ok: password.length >= 8, label: "At least 8 characters" },
    { ok: /[A-Z]/.test(password) && /[a-z]/.test(password), label: "Upper and lowercase letters" },
    { ok: /\d/.test(password), label: "At least one number" },
    { ok: /[^A-Za-z0-9]/.test(password), label: "At least one symbol" },
  ];

  return (
    <div className="mt-2" aria-live="polite">
      <div className="mb-1.5 flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              i < s ? barClass : "bg-muted",
            )}
          />
        ))}
      </div>
      <div className={cn("mb-1.5 text-xs font-medium", colorClass)}>{label}</div>
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {checks.map((c, i) => (
          <li
            key={i}
            className={cn(
              "flex items-center gap-1.5 text-xs",
              c.ok ? "text-success" : "text-muted-foreground",
            )}
          >
            {c.ok ? <Check size={12} /> : <X size={12} />}
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
