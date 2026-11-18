"use client";

import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";

/**
 * The secondary sidebar's panel (#1051), Supabase's product-menu panel: it sits between the icon
 * rail and the content pane, with a 48px header bar (the top bar's height) naming it and a body
 * that scrolls on its own (scrollbar hidden until hover) while the header stays put.
 *
 * Props:
 * - `title`: the header's text (14px/500); also names the resize handle.
 * - `children`: the body (a SectionMenu's groups, or Explore's facets later, #1052).
 * - `actions`: optional controls at the header's right edge.
 * - `resizable` (default true): a drag handle on the right edge resizes it between `MIN_WIDTH`
 *   and `MAX_WIDTH`; focused, ←/→ resize it by 16px (Shift: 64px), Home/End jump to the ends.
 *   The width is remembered in localStorage (`apilens.sidepanel.width`) for every panel.
 *
 * Below 860px the panel sits in the rail's drawer instead (shell.css): full drawer width, no
 * handle. It animates in (width 0 → its width, fade, 120ms; none with reduced motion) only when
 * the page before it had no panel, so moving between a section's sub-pages never re-animates it.
 */
export function SidePanel({ title, actions, resizable = true, children }: { title: string; actions?: ReactNode; resizable?: boolean; children?: ReactNode }) {
  const [width, setWidth] = usePanelWidth();
  // Animate only when entering from a page without a panel; never on a hard load (null).
  const [enter] = useState(() => lastHadPanel === false);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(drag.current.w + e.clientX - drag.current.x, false);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setWidth(width, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: MIN_WIDTH, End: MAX_WIDTH }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setWidth(next, true);
  };

  return (
    <div className={`sp${enter ? " sp--enter" : ""}`} style={{ "--sp-w": `${width}px` } as CSSProperties} data-panel="">
      <div className="sp-head">
        <p className="sp-title">{title}</p>
        {actions ? <div className="sp-actions">{actions}</div> : null}
      </div>
      <div className="sp-body">{children}</div>
      {resizable ? (
        // A focusable separator is the ARIA pattern for a splitter (WAI-ARIA "window splitter").
        // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or pointer drags.
        <div
          className="sp-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${title}`}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        />
      ) : null}
    </div>
  );
}

/** Supabase's product menu: 256px by default and at least, 512px at most. */
export const MIN_WIDTH = 256;
export const MAX_WIDTH = 512;
const KEY = "apilens.sidepanel.width";

const clamp = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

// Module state, shared by every shell the browser renders: the width last used (so a panel that
// mounts on another section starts at it, no jump) and whether the last shell had a panel.
let lastWidth: number | null = null;
let lastHadPanel: boolean | null = null;

/** Called by the app shell after it commits: whether this page has a panel (see SidePanel's enter animation). */
export function notePanel(has: boolean): void {
  lastHadPanel = has;
}

/** Whether the page before this one had a panel (for the shell's exit animation); null on a hard load. */
export function hadPanel(): boolean | null {
  return lastHadPanel;
}

/** The panel width last used, or the default before any. */
export function panelWidth(): number {
  return lastWidth ?? MIN_WIDTH;
}

/** The remembered width and a setter that clamps it and, with `save`, remembers it. */
function usePanelWidth(): [number, (w: number, save: boolean) => void] {
  const [width, setWidthState] = useState(() => lastWidth ?? MIN_WIDTH);
  useEffect(() => {
    if (lastWidth !== null) return;
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (Number.isFinite(saved) && saved > 0) {
        lastWidth = clamp(saved);
        setWidthState(lastWidth);
      }
    } catch {}
  }, []);
  const set = (w: number, save: boolean) => {
    const next = clamp(w);
    lastWidth = next;
    setWidthState(next);
    if (!save) return;
    try {
      localStorage.setItem(KEY, String(next));
    } catch {}
  };
  return [width, set];
}
