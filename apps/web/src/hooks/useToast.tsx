"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { Check, X, Info, AlertTriangle } from "lucide-react";

type ToastKind = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** Auto-dismiss timer in ms. 0 keeps the toast until manually dismissed. */
  duration: number;
}

interface ToastApi {
  success: (message: string, options?: { duration?: number }) => number;
  error: (message: string, options?: { duration?: number }) => number;
  info: (message: string, options?: { duration?: number }) => number;
  warning: (message: string, options?: { duration?: number }) => number;
  dismiss: (id: number) => void;
}

interface ToastContextValue {
  toast: ToastApi;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 7000,  // longer because errors matter more
};

/**
 * Global toast provider. Mounted once in app/layout.tsx. Toasts queue up and
 * render bottom-center using the existing .settings-toast styles.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, options?: { duration?: number }): number => {
      const id = ++idRef.current;
      const duration = options?.duration ?? DEFAULT_DURATIONS[kind];
      setItems((prev) => [...prev, { id, kind, message, duration }]);
      if (duration > 0) {
        // Use a fresh setTimeout (not useEffect) so the timer is attached at
        // the moment of creation, not on re-render.
        setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  const toast: ToastApi = {
    success: (m, o) => push("success", m, o),
    error: (m, o) => push("error", m, o),
    info: (m, o) => push("info", m, o),
    warning: (m, o) => push("warning", m, o),
    dismiss,
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div
      // aria-live polite so non-critical toasts don't interrupt screen readers
      role="region"
      aria-live="polite"
      aria-label="Notifications"
      style={{
        position: "fixed",
        bottom: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        zIndex: 9999,
        pointerEvents: "none",
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      {items.map((item) => (
        <ToastNode key={item.id} item={item} onDismiss={() => onDismiss(item.id)} />
      ))}
    </div>
  );
}

function ToastNode({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = item.kind === "success"
    ? Check
    : item.kind === "error"
    ? X
    : item.kind === "warning"
    ? AlertTriangle
    : Info;

  // Reuse the existing .settings-toast styling so the look matches what was
  // already in the app. Add inline overrides for kind-specific colour.
  const accent = item.kind === "success"
    ? "var(--success, #16a34a)"
    : item.kind === "error"
    ? "var(--danger, #dc2626)"
    : item.kind === "warning"
    ? "#f59e0b"
    : "var(--accent, #3b82f6)";

  return (
    <div
      role={item.kind === "error" || item.kind === "warning" ? "alert" : "status"}
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        padding: "10px 14px",
        background: "var(--bg-secondary, #0a0a0a)",
        border: "1px solid var(--border-color, #1f1f1f)",
        borderRadius: "10px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
        minWidth: "260px",
        maxWidth: "400px",
        fontSize: "13px",
        lineHeight: 1.5,
        color: "var(--text-primary)",
        animation: "toast-in 0.2s ease",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "20px",
          height: "20px",
          color: accent,
          flexShrink: 0,
          marginTop: "1px",
        }}
        aria-hidden="true"
      >
        <Icon size={16} />
      </span>
      <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{item.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "2px",
          color: "var(--text-secondary, #888)",
          flexShrink: 0,
          borderRadius: "4px",
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Get the toast API. Must be used inside a `<ToastProvider>` — throws if not.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() must be used inside <ToastProvider>");
  }
  return ctx.toast;
}

/**
 * Safe-call hook for places that might or might not have a provider (e.g.,
 * unit tests, isolated stories). Returns a no-op toast when missing.
 */
export function useToastOptional(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx.toast;
  const noop = (): number => 0;
  return { success: noop, error: noop, info: noop, warning: noop, dismiss: () => {} };
}
