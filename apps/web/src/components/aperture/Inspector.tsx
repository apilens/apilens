"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface InspectorProps {
  title: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}

/**
 * Aperture <Inspector> — the right-side slide-over for in-context detail
 * (Constancy + Focus principles). Portals to <body>, blurs the stage behind it,
 * locks background scroll, traps Escape, and never clips inside a transformed
 * ancestor. Generalised from the endpoint RequestPayloadModal.
 */
export default function Inspector({ title, actions, onClose, width = 560, children }: InspectorProps) {
  // Escape closes (capture-phase + stop so nested inspectors close one at a time).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Lock background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const content = (
    <div className="ap-inspector-overlay" onClick={onClose}>
      <aside
        className="ap-inspector"
        style={{ width: `min(${width}px, 100%)` }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="ap-inspector-head">
          <div className="ap-inspector-title">{title}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {actions}
            <button type="button" className="ap-icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="ap-inspector-body">{children}</div>
      </aside>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}
