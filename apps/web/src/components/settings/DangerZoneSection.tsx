"use client";

import { useState, useEffect } from "react";
import { Trash2, AlertTriangle, Loader2 } from "lucide-react";
import SettingsCard from "./SettingsCard";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/reui/alert-dialog";
import { Button } from "@/components/reui/button";
import { Checkbox } from "@/components/reui/checkbox";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";

interface DangerZoneSectionProps {
  onDeleteAccount: () => Promise<void>;
}

interface AccountFootprint {
  passkeys: number;
  sessions: number;
}

/**
 * Fetches a quick snapshot of what'll be erased when the user deletes their
 * account so the confirm modal can show concrete numbers ("2 passkeys, 3
 * sessions") instead of vague copy. Small parallel requests, only fired when
 * the user opens the modal. (API keys are project-level — managed per project —
 * so they're not part of the account footprint.)
 */
async function fetchFootprint(): Promise<AccountFootprint> {
  const get = async (url: string): Promise<unknown[]> => {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return data.passkeys || data.sessions || [];
  };
  const [passkeys, sessions] = await Promise.all([
    get("/api/account/passkeys"),
    get("/api/account/sessions"),
  ]);
  return {
    passkeys: passkeys.length,
    sessions: sessions.length,
  };
}

export default function DangerZoneSection({ onDeleteAccount }: DangerZoneSectionProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [typedWord, setTypedWord] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [footprint, setFootprint] = useState<AccountFootprint | null>(null);
  const [isLoadingFootprint, setIsLoadingFootprint] = useState(false);

  // Lazily load the counts when the modal opens.
  useEffect(() => {
    if (!showConfirm) return;
    setIsLoadingFootprint(true);
    fetchFootprint()
      .then(setFootprint)
      .catch(() => setFootprint({ passkeys: 0, sessions: 0 }))
      .finally(() => setIsLoadingFootprint(false));
  }, [showConfirm]);

  // Reset modal state when it closes.
  useEffect(() => {
    if (!showConfirm) {
      setTypedWord("");
      setAcknowledged(false);
      setFootprint(null);
    }
  }, [showConfirm]);

  const canDelete = acknowledged && typedWord === "DELETE" && !isDeleting;

  const handleDelete = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteAccount();
      // Parent handler logs out and redirects on success — no further work here.
    } finally {
      setIsDeleting(false);
    }
  };

  // Build the bulleted list of what's about to disappear. Always include the
  // baseline items even when counts are 0 so the user sees the full scope.
  const buildFootprintItems = () => {
    if (!footprint) return null;
    const lines: string[] = [];
    lines.push("Your profile and email");
    if (footprint.passkeys > 0) {
      lines.push(`${footprint.passkeys} passkey${footprint.passkeys === 1 ? "" : "s"}`);
    }
    if (footprint.sessions > 0) {
      lines.push(`${footprint.sessions} active session${footprint.sessions === 1 ? "" : "s"}`);
    }
    lines.push("All projects, apps, and observability data");
    return lines;
  };

  const items = buildFootprintItems();

  return (
    <>
      <SettingsCard
        title="Danger Zone"
        description="Irreversible actions for your account"
        variant="danger"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground">Delete Account</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Permanently delete your account and all data we hold about you. There's no undo.
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setShowConfirm(true)}>
            <Trash2 size={14} />
            Delete account
          </Button>
        </div>
      </SettingsCard>

      <AlertDialog
        open={showConfirm}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setShowConfirm(false);
        }}
      >
        <AlertDialogContent
          className="sm:max-w-[480px]"
          onEscapeKeyDown={(e) => {
            if (isDeleting) e.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle size={20} />
            </div>
            <AlertDialogTitle>Permanently delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              The following data will be erased — this cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {isLoadingFootprint ? (
            <div className="flex items-center gap-2.5 py-3 text-[13px] text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Calculating what will be removed…
            </div>
          ) : items ? (
            <ul className="m-0 list-inside list-disc rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] leading-7 text-foreground">
              {items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-col gap-4">
            <Label className="flex cursor-pointer items-start gap-2.5 text-[13px] font-normal leading-normal text-foreground">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
                disabled={isDeleting}
                className="mt-0.5"
              />
              <span>
                I understand this cannot be undone, and I've copied any data I need to keep.
              </span>
            </Label>

            <div
              className={cn(
                "flex flex-col gap-2 transition-opacity",
                acknowledged ? "opacity-100" : "opacity-40",
              )}
            >
              <Label
                htmlFor="delete-confirm-word"
                className="text-[13px] font-normal text-muted-foreground"
              >
                <span>
                  Type{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
                    DELETE
                  </code>{" "}
                  to confirm
                </span>
              </Label>
              <Input
                id="delete-confirm-word"
                type="text"
                value={typedWord}
                onChange={(e) => setTypedWord(e.target.value)}
                placeholder="DELETE"
                disabled={!acknowledged || isDeleting}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirm(false)}
              disabled={isDeleting}
            >
              Keep my account
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={!canDelete}>
              {isDeleting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Deleting…
                </>
              ) : (
                "Permanently delete account"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
