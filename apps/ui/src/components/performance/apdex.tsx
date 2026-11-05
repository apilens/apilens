"use client";

import { useEffect, useId, useState } from "react";
import { APDEX_BANDS, apdexPosition } from "@/lib/performance";
import { apdexRating, formatApdex } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { LiveNumber } from "../traffic/live";

/**
 * The Apdex tile (#595): the score, its rating and a gauge from 0 to 1 split into the standard
 * rating bands, with a marker at the score. The gauge is a `meter` with a text value for assistive
 * technology, and the rating is written under the score, so the bands are not told apart by color
 * alone. The info button shows how Apdex is scored on hover or focus (Escape hides it).
 */
export function ApdexTile({ apdex, explanation }: { apdex: number | null | undefined; explanation: readonly string[] }) {
  const rating = apdexRating(apdex);
  const at = apdexPosition(apdex);
  const value = formatApdex(apdex);
  return (
    <div className="pf-apdex">
      <dt className="pf-apdex__label">
        Apdex <ApdexHelp lines={explanation} />
      </dt>
      <dd>
        <span className="tr-tile__value">
          <LiveNumber text={value} />
        </span>
        <span className="tr-tile__sub">{rating ?? "No requests to score"}</span>
        <div
          className="pf-gauge"
          role="meter"
          aria-label="Apdex"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={at === null ? undefined : at / 100}
          aria-valuetext={rating ? `${value}, ${rating}` : "No requests to score"}
        >
          <div className="pf-gauge__track" aria-hidden="true">
            {APDEX_BANDS.map((b) => (
              <span key={b.label} className={`pf-band pf-band--${b.label.toLowerCase()}`} style={{ flexGrow: Math.round((b.to - b.from) * 100) }} />
            ))}
            {at === null ? null : <span className="pf-gauge__mark" style={{ left: `${at}%` }} />}
          </div>
          <div className="pf-gauge__scale" aria-hidden="true">
            <span>0</span>
            <span>0.5</span>
            <span>1</span>
          </div>
        </div>
      </dd>
    </div>
  );
}

function ApdexHelp({ lines }: { lines: readonly string[] }) {
  const id = useId();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHidden(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);
  return (
    <span className={`pf-help${hidden ? " is-dismissed" : ""}`} onMouseLeave={() => setHidden(false)} onBlur={() => setHidden(false)}>
      <button type="button" className="pf-help__btn" aria-label="How Apdex is scored" aria-describedby={id}>
        <ObIcon name="info" />
      </button>
      <span role="tooltip" id={id} className="pf-help__tip">
        {lines.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </span>
    </span>
  );
}
