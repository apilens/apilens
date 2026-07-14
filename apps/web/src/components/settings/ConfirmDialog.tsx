"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/reui/alert-dialog";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  /** If set, user must type this exact word before the confirm button enables. */
  confirmWord?: string;
  variant?: "default" | "danger";
  isLoading?: boolean;
}

/**
 * Modal confirmation dialog. Used directly via JSX *or* imperatively through
 * the `useConfirm()` hook. Thin wrapper over ReUI's AlertDialog — focus trap,
 * Escape to close, and focus restoration come from Radix; the optional
 * typed-word confirmation is layered on top.
 */
export default function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "Confirm",
  confirmWord,
  variant = "default",
  isLoading = false,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState("");

  const isConfirmDisabled = confirmWord
    ? inputValue !== confirmWord || isLoading
    : isLoading;

  // Reset typed input on open.
  useEffect(() => {
    if (isOpen) setInputValue("");
  }, [isOpen]);

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isLoading) onClose();
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(e) => {
          if (isLoading) e.preventDefault();
        }}
      >
        <AlertDialogHeader>
          {variant === "danger" && (
            <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle size={20} />
            </div>
          )}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {confirmWord && (
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="confirm-dialog-input"
              className="text-[13px] font-normal text-muted-foreground"
            >
              <span>
                Type{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
                  {confirmWord}
                </code>{" "}
                to confirm
              </span>
            </Label>
            <Input
              id="confirm-dialog-input"
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={confirmWord}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={isLoading}
            />
          </div>
        )}

        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant={variant === "danger" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={isConfirmDisabled}
            aria-busy={isLoading || undefined}
          >
            {isLoading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Processing…
              </>
            ) : (
              confirmText
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
