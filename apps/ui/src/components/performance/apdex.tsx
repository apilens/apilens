"use client";

import { useEffect, useId, useState } from "react";
import { pointX, tooltipText } from "@/lib/chart-hover";
import { APDEX_BANDS, apdexBandAt, apdexBandRange, apdexPosition } from "@/lib/performance";
import { apdexRating, formatApdex } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { ChartAnnounce, ChartTooltip } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";
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
        <Gauge at={at} value={value} rating={rating} />
      </dd>
    </div>
  );
}

/** Where the gauge reads on hover: 101 points, 0.00 to 1.00, spread across the track. */
const GAUGE_POINTS = 101;

/**
 * The gauge: the rating bands with a marker at the score. It is a focusable `meter`; hovering,
 * tapping or arrowing along it (PageUp/PageDown by a tenth) shows the band under the pointer with
 * its span, next to the score and its rating, in the shared chart tooltip.
 */
function Gauge({ at, value, rating }: { at: number | null; value: string; rating: string | null }) {
  const hover = useChartHover<HTMLDivElement>(GAUGE_POINTS, "point");
  const i = hover.index;
  const band = i !== null ? apdexBandAt(i / (GAUGE_POINTS - 1)) : null;
  const title = band ? `${band.label} band` : "";
  const rows = band
    ? [
        { label: "Band", value: apdexBandRange(band) },
        { label: "This score", value: rating ? `${value}, ${rating}` : "No requests to score" },
      ]
    : [];
  return (
    <div className="pf-gauge">
      <div
        ref={hover.ref}
        className="pf-gauge__track ct-box"
        role="meter"
        aria-label="Apdex"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={at === null ? undefined : at / 100}
        aria-valuetext={rating ? `${value}, ${rating}` : "No requests to score"}
        {...hover.bind}
      >
        {APDEX_BANDS.map((b) => (
          <span key={b.label} aria-hidden="true" className={`pf-band pf-band--${b.label.toLowerCase()}${band?.label === b.label ? " is-on" : ""}`} style={{ flexGrow: Math.round((b.to - b.from) * 100) }} />
        ))}
        {at === null ? null : <span className="pf-gauge__mark" aria-hidden="true" style={{ left: `${at}%` }} />}
        {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, GAUGE_POINTS, "point")} boxWidth={hover.width} title={title} rows={rows} /> : null}
      </div>
      <ChartAnnounce text={band ? tooltipText(title, rows) : ""} />
      <div className="pf-gauge__scale" aria-hidden="true">
        <span>0</span>
        <span>0.5</span>
        <span>1</span>
      </div>
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
