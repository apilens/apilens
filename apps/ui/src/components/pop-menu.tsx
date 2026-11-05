"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Floating menu portalled to <body> and positioned from its trigger, so no scroll container can
 * clip it and nothing can stack above it. Closes on Escape, outside click and resize.
 */
export function PopMenu({
  open,
  onClose,
  triggerRef,
  label,
  align = "start",
  role = "menu",
  id,
  children,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  label: string;
  align?: "start" | "end" | "side" | "up" | "side-up";
  /** `dialog` for a small inline form in place of menu items. */
  role?: "menu" | "dialog";
  id?: string;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      const width = 280;
      const side = align === "side" || align === "side-up";
      // Side menus clear the whole sidebar, not just the trigger inside it.
      const edge = triggerRef.current?.closest("aside")?.getBoundingClientRect().right ?? r.right;
      const left = Math.max(8, Math.min(align === "end" ? r.right - width : side ? edge + 8 : r.left, window.innerWidth - width - 8));
      if (align === "up") setPos({ bottom: window.innerHeight - r.top + 8, left });
      else if (align === "side-up") setPos({ bottom: window.innerHeight - r.bottom, left });
      else setPos({ top: Math.max(8, Math.min(side ? r.top : r.bottom + 8, window.innerHeight - 360)), left });
    }
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !triggerRef.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [open, align, onClose, triggerRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div ref={menu} className="ah cp-orgmenu org-pop" id={id} role={role} aria-label={label} style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}>
      {children}
    </div>,
    document.body,
  );
}
