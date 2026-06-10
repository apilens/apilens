export interface TabItem<K extends string = string> {
  key: K;
  label: React.ReactNode;
}

export interface TabsProps<K extends string = string> {
  tabs: ReadonlyArray<TabItem<K>>;
  active: K;
  onChange: (key: K) => void;
  className?: string;
}

/** Aperture <Tabs> — underline tab bar. */
export default function Tabs<K extends string = string>({ tabs, active, onChange, className = "" }: TabsProps<K>) {
  return (
    <nav className={`ap-tabs ${className}`.trim()} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          className={`ap-tab${active === t.key ? " is-active" : ""}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
