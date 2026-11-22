import type { ReactNode } from "react";
import { compactCount } from "@/lib/explore-query";
import type { NamedApp } from "@/lib/identity";
import { type TrafficState, appName, trafficHref } from "@/lib/traffic";
import { Icon } from "../icons";
import { SidePanel } from "../shell/side-panel";
import { MetricFilters } from "./metric-filters";
import { TrafficTimeRange } from "./time-range";
import "../explore/explore.css";

type FacetValue = { value: string; label: string; count: number };
type Field = "env" | "app" | "method" | "path" | "consumer";

/**
 * Traffic's secondary sidebar, Explore's facet panel in look: the time range (Explore's button and
 * date picker), then a section per
 * field the page can be narrowed by (environment, app when there are several, method, endpoint,
 * consumer), then Endpoint metrics (4xx, 5xx, p95, p50 conditions on the table's rows);
 * each value with its requests under the other filters. A value is a link: picking it narrows the
 * page to it (one per field, as the traffic reads take), picking it again lets it go. Sections
 * fold (`<details>`), so the panel works before JavaScript. Reset clears every filter.
 */
export function TrafficMenu({
  project,
  query: q,
  apps,
  envs,
  appCounts,
  methods,
  paths,
  consumers,
}: {
  project: string;
  query: TrafficState;
  apps: NamedApp[] | null;
  envs: FacetValue[] | null;
  appCounts: FacetValue[] | null;
  methods: FacetValue[] | null;
  paths: FacetValue[] | null;
  consumers: FacetValue[] | null;
}) {
  const current: Record<Field, string> = { env: q.env, app: q.app, method: q.method ?? "", path: q.path ?? "", consumer: q.consumer ?? "" };
  const any = Object.values(current).some(Boolean) || (q.metrics ?? []).length > 0;
  const hrefFor = (f: Field, v: string) => trafficHref(project, { ...q, [f]: current[f] === v ? "" : v });
  const reset = trafficHref(project, { range: q.range, env: "", app: "", method: "", path: "", consumer: "", metrics: [], from: q.from, to: q.to });
  return (
    <SidePanel
      title="Traffic"
      actions={
        any ? (
          <a className="exf-reset" href={reset}>
            Reset
          </a>
        ) : null
      }
    >
      <div className="exf" role="region" aria-label="Filters">
        <div className="exf-scroll">
          <TrafficTimeRange project={project} query={q} />
          <FacetSection title="Environment" field="env" values={envs} current={current.env} hrefFor={hrefFor} />
          {apps && apps.length > 1 ? (
            <FacetSection title="App" field="app" values={appCounts?.map((a) => ({ ...a, label: appName(apps, a.value) })) ?? null} current={current.app} hrefFor={hrefFor} />
          ) : null}
          <FacetSection title="Method" field="method" mono values={methods?.map((m) => ({ ...m, value: m.value.toUpperCase(), label: m.value.toUpperCase() })) ?? null} current={current.method} hrefFor={hrefFor} />
          <FacetSection title="Endpoint" field="path" mono values={paths} current={current.path} hrefFor={hrefFor} />
          <FacetSection title="Consumer" field="consumer" values={consumers} current={current.consumer} hrefFor={hrefFor} />
          <Section title="Endpoint metrics">
            <MetricFilters project={project} query={q} />
          </Section>
        </div>
      </div>
    </SidePanel>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="exf-facet tr-facet" open>
      <summary className="exf-facet__head">
        <span className="exf-facet__title">
          <span className="tr-facet__btn">
            <span className="exf-facet__name">{title}</span>
            <Icon name="chevronDown" />
          </span>
        </span>
      </summary>
      <div className="exf-facet__body">{children}</div>
    </details>
  );
}

function FacetSection({
  title,
  field,
  values,
  current,
  hrefFor,
  mono = false,
}: {
  title: string;
  field: Field;
  values: FacetValue[] | null;
  current: string;
  hrefFor: (f: Field, v: string) => string;
  mono?: boolean;
}) {
  // The current value stays listed even when the counts left it out.
  const list = values && current && !values.some((v) => v.value === current) ? [{ value: current, label: current, count: 0 }, ...values] : values;
  return (
    <Section title={title}>
      {list === null ? (
        <p className="tr-fnote">Couldn’t load these just now.</p>
      ) : list.length === 0 ? (
        <p className="tr-fnote">No requests in this range.</p>
      ) : (
        <ul className="exf-list tr-flist">
          {list.map((v) => (
            <Item key={v.value} on={current === v.value} href={hrefFor(field, v.value)} label={v.label || v.value} count={v.count} mono={mono} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function Item({ on, href, label, count, mono = false }: { on: boolean; href: string; label: string; count?: number; mono?: boolean }) {
  return (
    <li className={`exf-item${on ? " is-checked" : ""}`}>
      <a className={`exf-label tr-flink${mono ? " is-mono" : ""}`} href={href} aria-current={on ? "true" : undefined} title={on ? `${label}: click to clear` : label}>
        <span className={`tr-fbox${on ? " is-on" : ""}`} aria-hidden="true">
          {on ? <Icon name="check" /> : null}
        </span>
        <span className="exf-label__text">{label}</span>
      </a>
      {count !== undefined ? (
        <span className="exf-count" title={`${count.toLocaleString("en-US")} requests`}>
          {compactCount(count)}
        </span>
      ) : null}
    </li>
  );
}
