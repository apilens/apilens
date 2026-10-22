"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import type { NavItem } from "./nav-config";

/**
 * Linear-style sequences. Ignored while typing or with modifiers held.
 *   G then <key>  go to a section (keys come from nav-config)
 *   O then P      open the scope switcher
 *   [             collapse / expand the sidebar
 *   ?             keyboard shortcuts
 */
export function useNavShortcuts({
  base,
  items,
  onToggleSidebar,
  onOpenSwitcher,
  onOpenHelp,
}: {
  base: string;
  items: NavItem[];
  onToggleSidebar: () => void;
  onOpenSwitcher: () => void;
  onOpenHelp: () => void;
}) {
  const router = useRouter();
  const handlers = React.useRef({ onToggleSidebar, onOpenSwitcher, onOpenHelp });
  React.useEffect(() => {
    handlers.current = { onToggleSidebar, onOpenSwitcher, onOpenHelp };
  });

  React.useEffect(() => {
    let pending: "g" | "o" | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return; // an overlay owns the keyboard
      const key = e.key.toLowerCase();

      if (pending === "g") {
        pending = null;
        const item = items.find((i) => i.shortcut.toLowerCase() === key);
        if (item) {
          e.preventDefault();
          router.push(base + item.href);
        }
        return;
      }
      if (pending === "o") {
        pending = null;
        if (key === "p") {
          e.preventDefault();
          handlers.current.onOpenSwitcher();
        }
        return;
      }
      if (e.key === "[") {
        e.preventDefault();
        handlers.current.onToggleSidebar();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        handlers.current.onOpenHelp();
        return;
      }
      if (key === "g" || key === "o") {
        pending = key;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = null), 1200);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [base, items, router]);
}
