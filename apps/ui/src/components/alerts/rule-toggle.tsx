"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateAlertRule } from "@/app/[project]/incidents/actions";
import { ruleDraftOf } from "@/lib/alerts";
import type { AlertRule } from "@/lib/identity";
import { useCan } from "@/lib/permissions";

/**
 * Disables an enabled rule, or enables a disabled one, from its incident page (#979), with the
 * rule as saved otherwise. Only for project admins (`alerts.manage`); nothing shows for anyone else.
 */
export function RuleToggle({ project, rule }: { project: string; rule: AlertRule }) {
  const manage = useCan("alerts.manage").allowed;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!manage) return null;
  const toggle = () => {
    if (pending) return;
    setError(null);
    start(async () => {
      const result = await updateAlertRule(project, rule.id, { ...ruleDraftOf(rule), enabled: !rule.enabled });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };
  return (
    <>
      <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={toggle} disabled={pending}>
        {rule.enabled ? "Disable rule" : "Enable rule"}
      </button>
      {error ? (
        <p className="ob-err" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
