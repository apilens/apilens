"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  ReactNode,
} from "react";
import ConfirmDialog from "@/components/settings/ConfirmDialog";

interface ConfirmOptions {
  title: string;
  description: string;
  confirmText?: string;
  confirmWord?: string;
  variant?: "default" | "danger";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Imperative confirm() API. Avoids the `useState({ showModal: true })` +
 * inline JSX pattern at the call site. Example:
 *
 *   const confirm = useConfirm();
 *   const handleDelete = async () => {
 *     if (await confirm({ title: "Delete?", description: "...", variant: "danger" })) {
 *       deleteThing();
 *     }
 *   };
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    setOpts(options);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleClose = () => {
    setOpen(false);
    resolveRef.current?.(false);
    resolveRef.current = null;
  };

  const handleConfirm = () => {
    setOpen(false);
    resolveRef.current?.(true);
    resolveRef.current = null;
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <ConfirmDialog
          isOpen={open}
          onClose={handleClose}
          onConfirm={handleConfirm}
          title={opts.title}
          description={opts.description}
          confirmText={opts.confirmText}
          confirmWord={opts.confirmWord}
          variant={opts.variant ?? "default"}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm() must be used inside <ConfirmProvider>");
  }
  return ctx;
}
