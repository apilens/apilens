export interface PanelProps {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/** Aperture <Panel> — the one card. Optional title + right-aligned hint header. */
export default function Panel({ title, hint, className = "", children }: PanelProps) {
  return (
    <section className={`ap-panel ${className}`.trim()}>
      {title || hint ? (
        <div className="ap-panel-head">
          {title ? <h4 className="ap-panel-title">{title}</h4> : <span />}
          {hint ? <span className="ap-panel-hint">{hint}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
