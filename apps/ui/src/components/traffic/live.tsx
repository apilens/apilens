"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { LIVE_INTERVAL_MS } from "@/lib/traffic";

/**
 * Keeps the page live: reads it again every 30 s while the tab is visible, by refreshing the
 * server components in place (the URL and scroll stay). It updates on its own, so it has a visible
 * Pause (WCAG 2.2.2); paused, nothing refreshes and nothing moves.
 */
export function LiveControl({ intervalMs = LIVE_INTERVAL_MS }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (paused) return;
    const tick = () => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    };
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [paused, intervalMs, router]);

  return (
    <div className="tr-live">
      <span className={`tr-live__state${paused ? " is-paused" : ""}`}>
        <span className="tr-live__dot" aria-hidden="true" />
        {paused ? "Paused" : "Live"}
      </span>
      <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}

/**
 * A number that updates in place: when `text` changes after the first render, the new value
 * slides in (150 ms; a plain swap with reduced motion). Rendered by the server as plain text.
 */
export function LiveNumber({ text }: { text: string }) {
  const previous = useRef(text);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (previous.current === text) return;
    previous.current = text;
    setTick((t) => t + 1);
  }, [text]);
  return (
    <span key={tick} className={`tr-livenum${tick > 0 ? " is-new" : ""}`}>
      {text}
    </span>
  );
}
