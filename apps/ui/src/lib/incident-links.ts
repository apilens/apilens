// Where an incident drills down to (#979, D3): Explore with the rule's scope (app, environment,
// the status class its metric counts, its filters) from the incident's start, the Errors page in
// the same environment and range, the rule's endpoint when it has one, and the rule's app. Pure,
// unit-tested in incident-links.test.ts.
import { appHref } from "./apps";
import { rangeCovering } from "./changes";
import { errorsHref } from "./errors";
import { exploreHref } from "./explore";
import { NO_FILTERS } from "./explore-filters";
import { isoSecond } from "./explore-timeline";
import type { AlertMetric, AlertRule, NamedApp } from "./identity";
import { endpointHref } from "./traffic";

/** The status filter of a metric's failing requests: 5xx, 4xx, both, or "" when it counts no errors. */
export function metricStatus(metric: AlertMetric): string {
  if (metric === "server_errors" || metric === "server_error_rate") return "5xx";
  if (metric === "client_errors" || metric === "client_error_rate") return "4xx";
  if (metric === "errors" || metric === "error_rate") return "4xx,5xx";
  return "";
}

/** A rule's endpoint filter ("METHOD /route" or "/route") as a method ("" for every method) and a path. */
export function parseEndpoint(endpoint: string | undefined): { method: string; path: string } | null {
  const s = (endpoint ?? "").trim();
  if (!s) return null;
  const m = s.match(/^([A-Za-z]{1,16})\s+(\/\S*)$/);
  if (m) return { method: m[1].toUpperCase(), path: m[2] };
  return s.startsWith("/") ? { method: "", path: s } : null;
}

export interface IncidentLink {
  label: string;
  href: string;
}

export interface IncidentLinks {
  /** Explore: "See failing requests" for an error metric, "See requests" for any other. */
  requests: IncidentLink;
  errors: IncidentLink;
  /** The endpoint's page, only when the rule filters one endpoint by method and route. */
  endpoint: IncidentLink | null;
  /** The rule's app page, null when the app is not one of the project's (archived, unknown). */
  app: string | null;
}

/**
 * The links of one rule's incident page. `startedAt` is the newest incident's start (Explore reads
 * from it, and the range is the smallest that holds it); without one the pages open at their
 * default range. `apps` names the project's apps, to find the rule's app's page.
 */
export function incidentLinks(
  project: string,
  rule: Pick<AlertRule, "app_id" | "environment" | "metric" | "filters">,
  apps: readonly Pick<NamedApp, "id" | "slug">[],
  startedAt: string | undefined,
  now: number,
): IncidentLinks {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const at = Number.isNaN(started) ? null : started;
  const range = at === null ? undefined : rangeCovering(at, now);
  const status = metricStatus(rule.metric);
  const ep = parseEndpoint(rule.filters?.endpoint);
  const f = rule.filters ?? {};
  const requests = exploreHref(project, {
    ...(range ? { range } : {}),
    ...(at === null ? {} : { from: isoSecond(at) }),
    filters: {
      ...NO_FILTERS,
      env: rule.environment,
      app: rule.app_id,
      status,
      method: ep?.method ?? "",
      path: ep?.path ?? "",
      consumer_id: f.consumer ?? "",
      consumer_group: f.group ?? "",
    },
  });
  const app = apps.find((a) => a.id === rule.app_id);
  return {
    requests: { label: status ? "See failing requests" : "See requests", href: requests },
    errors: { label: "Open in Errors", href: errorsHref(project, { range, env: rule.environment }) },
    endpoint:
      ep && ep.method
        ? { label: "Endpoint", href: endpointHref(project, ep, { range, env: rule.environment, app: rule.app_id }) }
        : null,
    app: app ? appHref(project, app.slug) : null,
  };
}
