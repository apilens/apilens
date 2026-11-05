import { type Bar, formatBucket, formatCount, sparklinePoints, stackBars } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";

const W = 960;
const H = 160;

export interface Series<K extends string> {
  key: K;
  label: string;
  /** A CSS class setting the series fill (tokens only, in consumers.css). */
  className: string;
}

/**
 * A stacked bar chart over time (one bar per bucket), drawn as inline SVG so it renders on the
 * server. Every bucket has a full-height hover target whose `<title>` lists the bucket's values;
 * the legend names every series, so identity never rests on color alone. `label` is the chart's
 * accessible name and `summary` its text alternative.
 */
export function StackedBars<K extends string>({
  label,
  summary,
  rows,
  series,
  range,
}: {
  label: string;
  summary: string;
  rows: (Record<K, number> & { ts: string })[];
  series: readonly Series<K>[];
  range: QueryRange;
}) {
  const { top, bars } = stackBars(rows, series.map((s) => s.key), W, H);
  const tip = (b: Bar<K>) => {
    const r = rows[b.index];
    return [formatBucket(r.ts, range), ...series.map((s) => `${s.label}: ${formatCount(r[s.key] ?? 0)}`)].join("\n");
  };
  const className = Object.fromEntries(series.map((s) => [s.key, s.className])) as Record<K, string>;
  const firstTs = rows[0]?.ts;
  const lastTs = rows[rows.length - 1]?.ts;
  return (
    <figure className="cs-chart">
      <ul className="cs-legend" aria-label={`${label} legend`}>
        {series.map((s) => (
          <li key={s.key}>
            <span className={`cs-swatch ${s.className}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="cs-plot">
        <span className="cs-axis-top" aria-hidden="true">
          {formatCount(top)}
        </span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}. ${summary}`}>
          <line className="cs-grid" x1="0" x2={W} y1={0.5} y2={0.5} />
          <line className="cs-grid" x1="0" x2={W} y1={H / 2} y2={H / 2} />
          <line className="cs-base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
          {bars.map((b) => (
            <g key={b.index} className="cs-bucket">
              <rect className="cs-hit" x={b.x} y={0} width={b.w} height={H}>
                <title>{tip(b)}</title>
              </rect>
              {b.segments.map((s) => (
                <rect key={s.key} className={className[s.key]} x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
              ))}
            </g>
          ))}
        </svg>
      </div>
      {firstTs && lastTs ? (
        <figcaption className="cs-axis-x" aria-hidden="true">
          <span>{formatBucket(firstTs, range)}</span>
          <span>{formatBucket(lastTs, range)}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}

/** A consumer's requests per bucket as a small line, for the table; decorative (the cell has the number). */
export function Sparkline({ values }: { values: readonly number[] | null }) {
  const v = values ?? [];
  if (v.length === 0) return null;
  return (
    <svg className="cs-spark" viewBox="0 0 96 22" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points={sparklinePoints(v, 96, 22)} />
    </svg>
  );
}
