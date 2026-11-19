"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Hover wait before a tooltip shows; keyboard focus shows it at once. */
const DELAY_MS = 400;

/**
 * Supabase's ShortcutTooltip (apps/studio/components/ui/ShortcutTooltip.tsx) for Explore's toolbar:
 * the control's name and its keys in small pills, 4px below the control (above it near the
 * bottom of the window), portalled so no
 * container clips it and kept inside the viewport. It hides while the control's own menu is open
 * (`aria-expanded`), on a press and on Escape. It is visual only: the control carries its own
 * `aria-label` and `aria-keyshortcuts`.
 */
export function Tip({ label, keys, children }: { label: string; keys?: string[]; children: ReactNode }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState<{ top: number; above: number; left: number } | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    clear();
    setAt(null);
  };
  const show = (wait: number) => {
    clear();
    timer.current = setTimeout(() => {
      const el = wrap.current?.firstElementChild;
      if (!el || el.getAttribute("aria-expanded") === "true") return;
      const r = el.getBoundingClientRect();
      setAt({ top: r.bottom + 4, above: r.top - 4, left: r.left + r.width / 2 });
    }, wait);
  };

  // Centre on the control, then clamp to the viewport once the tooltip's size is known; with no
  // room below (the drawer's footer) it goes above.
  useEffect(() => {
    const t = tip.current;
    if (!at || !t) return;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    t.style.left = `${Math.max(8, Math.min(at.left - w / 2, window.innerWidth - w - 8))}px`;
    if (at.top + h > window.innerHeight - 8) t.style.top = `${Math.max(8, at.above - h)}px`;
    t.style.visibility = "visible";
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
    };
  }, [at]);

  useEffect(() => clear, []);

  return (
    <span
      ref={wrap}
      className="ex-tipw"
      onPointerEnter={(e) => e.pointerType === "mouse" && show(DELAY_MS)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => e.target === wrap.current?.firstElementChild && e.target.matches(":focus-visible") && show(0)}
      onBlur={hide}
    >
      {children}
      {at
        ? createPortal(
            <div ref={tip} className="ex-tip" role="tooltip" aria-hidden="true" style={{ top: at.top, left: at.left, visibility: "hidden" }}>
              <span>{label}</span>
              {keys?.length ? (
                <span className="ex-tip__keys">
                  {keys.map((k, i) =>
                    k === "then" ? (
                      <span key={i} className="ex-tip__then">
                        then
                      </span>
                    ) : (
                      <kbd key={i}>{k}</kbd>
                    ),
                  )}
                </span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
