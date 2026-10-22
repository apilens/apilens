"use client";

import * as React from "react";

import { useMaybeCan, type Action } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { Label } from "./label";

/**
 * Label + control + hint/error, with ids wired so screen readers announce the
 * hint and the error. Every form control in the app goes through Field.
 *
 *   <Field label="Project name" hint="Shown in the switcher." error={err}>
 *     <Input defaultValue="checkout-api" />
 *   </Field>
 *
 * `editableBy` makes the control read-only (not disabled: still focusable and
 * announced) for users who lack the permission, and says why.
 */
export function Field({
  label,
  hint,
  error,
  editableBy,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  editableBy?: Action;
  className?: string;
  children: React.ReactElement<React.ComponentProps<"input">>;
}) {
  const id = React.useId();
  const { allowed, reason } = useMaybeCan(editableBy);
  const helper = allowed ? hint : reason ?? hint;
  const hintId = helper ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const control = React.cloneElement(children, {
    id,
    readOnly: allowed ? children.props.readOnly : true,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": [errorId, hintId].filter(Boolean).join(" ") || undefined,
  });

  return (
    <div data-slot="field" className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : helper ? (
        <p id={hintId} className="text-xs text-subtle-foreground">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
