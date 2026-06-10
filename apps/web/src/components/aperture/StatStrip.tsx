export type StatTone = "good" | "warn" | "bad" | undefined;

export interface Stat {
  label: string;
  value: string;
  sub?: string;
  tone?: StatTone;
}

export interface StatStripProps {
  stats: Stat[];
  className?: string;
}

/** Aperture <StatStrip> — the golden-signal instrument. One row of toned metrics. */
export default function StatStrip({ stats, className = "" }: StatStripProps) {
  return (
    <div className={`ap-statstrip ${className}`.trim()}>
      {stats.map((s) => (
        <div key={s.label} className="ap-stat">
          <p className="ap-stat-label">{s.label}</p>
          <p className={`ap-stat-value${s.tone ? ` tone-${s.tone}` : ""}`}>{s.value}</p>
          <p className="ap-stat-sub">{s.sub || " "}</p>
        </div>
      ))}
    </div>
  );
}
