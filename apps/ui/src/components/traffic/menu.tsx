import Link from "next/link";
import type { ReactNode } from "react";
import type { NamedApp } from "@/lib/identity";
import { type TrafficState, appName, trafficHref } from "@/lib/traffic";
import { Icon } from "../icons";
import { SidePanel } from "../shell/side-panel";
import { Item } from "./facet-item";
import { SearchableList } from "./searchable-list";
import { STATUS_LEVELS, codeOn, levelState, toggleCode, toggleLevel } from "@/lib/traffic-status";
import { TrafficTimeRange } from "./time-range";
import "../explore/explore.css";

type FacetValue = { value: string; label: string; count: number };
type Field = "env" | "app" | "method" | "path" | "consumer" | "status";


/**
 * Traffic's secondary sidebar, Explore's facet panel in look: the time range (Explore's button and
 * date picker), then a section per field the page can be narrowed by (environment, app, method),
 * as Explore lists them, then Level (success 2xx–3xx, warning 4xx, error 5xx) and Status (the
 * codes, with Explore's facet search), each value with its requests under the other filters.
 * Endpoints, consumers and the table's metric conditions (4xx, 5xx, p95, p50 with > < =) are
 * filtered from the filter bar and the table's ⋯ menus. A value is a link. Environment, app and
 * method take one value (as the traffic reads do): picking one narrows to it, again lets it go.
 * Level and Status tick like Explore's (lib/traffic-status): any mix of levels and codes, a level
 * partly ticked when only some of its codes are in. Every row's Only (on hover) keeps it alone.
 * Sections fold (`<details>`), so the panel works before JavaScript. Reset clears every filter.
 */
export function TrafficMenu({
  project,
  query: q,
  apps,
  envs,
  appCounts,
  methods,
  statuses,
}: {
  project: string;
  query: TrafficState;
  apps: NamedApp[] | null;
  envs: FacetValue[] | null;
  appCounts: FacetValue[] | null;
  methods: FacetValue[] | null;
  /** Requests per status code under the other filters (request facets). */
  statuses: FacetValue[] | null;
}) {
  const current: Record<Field, string> = { env: q.env, app: q.app, method: q.method ?? "", path: q.path ?? "", consumer: q.consumer ?? "", status: q.status ?? "" };
  const any = Object.values(current).some(Boolean) || (q.metrics ?? []).length > 0;
  const hrefFor = (f: Field, v: string) => trafficHref(project, { ...q, [f]: current[f] === v ? "" : v });
  const onlyFor = (f: Field, v: string) => trafficHref(project, { ...q, [f]: v });
  const reset = trafficHref(project, { range: q.range, env: "", app: "", method: "", path: "", consumer: "", status: "", metrics: [], from: q.from, to: q.to });
  // A level's count: the requests of its codes (the codes are counted under the other filters).
  const codes = (statuses ?? []).filter((v) => /^\d{3}$/.test(v.value));
  const levelCount = (cls: string) => codes.filter((c) => cls.split(",").some((k) => c.value[0] === k[0])).reduce((n, c) => n + c.count, 0);
  return (
    <SidePanel
      title="Traffic"
      actions={
        any ? (
          <Link className="exf-reset" href={reset} scroll={false} prefetch={false}>
            Reset
          </Link>
        ) : null
      }
    >
      <div className="exf" role="region" aria-label="Filters">
        <div className="exf-scroll">
          <TrafficTimeRange project={project} query={q} />
          <FacetSection title="Environment" field="env" values={envs} current={current.env} hrefFor={hrefFor} onlyFor={onlyFor} />
          {apps && apps.length > 0 ? (
            <FacetSection title="App" field="app" values={appCounts?.map((a) => ({ ...a, label: appName(apps, a.value) })) ?? null} current={current.app} hrefFor={hrefFor} onlyFor={onlyFor} />
          ) : null}
          <FacetSection title="Method" field="method" mono values={methods?.map((m) => ({ ...m, value: m.value.toUpperCase(), label: m.value.toUpperCase() })) ?? null} current={current.method} hrefFor={hrefFor} onlyFor={onlyFor} />
          <Section title="Level">
            <ul className="exf-list tr-flist">
              {STATUS_LEVELS.map((l) => (
                <Item
                  key={l.key}
                  on={levelState(current.status, l.classes) === "on"}
                  partial={levelState(current.status, l.classes) === "partial"}
                  href={trafficHref(project, { ...q, status: toggleLevel(current.status, l.classes) })}
                  only={onlyFor("status", l.classes.join(","))}
                  label={l.label}
                  count={statuses === null ? undefined : levelCount(l.classes.join(","))}
                  body={
                    <span className="exf-level">
                      <span className="exf-level__name">{l.label}</span>
                      <span className="exf-level__tag">
                        <span className={`exf-swatch exf-swatch--${l.key}`} aria-hidden="true" />
                        <span className="exf-level__cls">{l.cls}</span>
                      </span>
                    </span>
                  }
                />
              ))}
            </ul>
          </Section>
          <Section title="Status">
            {statuses === null ? (
              <p className="tr-fnote">Couldn’t load these just now.</p>
            ) : codes.length === 0 ? (
              <p className="tr-fnote">No requests in this range.</p>
            ) : (
              <SearchableList
                label="Status"
                codes
                rows={codes.map((c) => ({
                  value: c.value,
                  label: c.value,
                  count: c.count,
                  on: codeOn(current.status, c.value),
                  href: trafficHref(project, { ...q, status: toggleCode(current.status, c.value, codes.map((k) => k.value)) }),
                  only: onlyFor("status", c.value),
                }))}
              />
            )}
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
  onlyFor,
  mono = false,
}: {
  title: string;
  field: Field;
  values: FacetValue[] | null;
  current: string;
  hrefFor: (f: Field, v: string) => string;
  onlyFor: (f: Field, v: string) => string;
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
            <Item key={v.value} on={current === v.value} href={hrefFor(field, v.value)} only={onlyFor(field, v.value)} label={v.label || v.value} count={v.count} mono={mono} />
          ))}
        </ul>
      )}
    </Section>
  );
}
