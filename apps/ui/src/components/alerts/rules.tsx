"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { READ_ONLY, RULES_LOAD_FAILED, channelsHref, formatMetric, newRuleHref, ruleHref, ruleSummary, rulesHref, scheduleText } from "@/lib/alerts";
import type { AlertRule } from "@/lib/identity";
import { parsePage, slicePage } from "@/lib/pagination";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import { Pagination } from "../pagination/pagination";
import { AlertsHeader, Empty, LoadFailed, StatusBadge } from "./common";

/**
 * `/<project>/incidents/rules` (#610): the project's alert rules by name, each with its scope
 * (app, environment, filters), what breaches it, how often it is checked, the channels it
 * notifies and where it stands now. Project admins (`alerts.manage`) create and edit rules;
 * everyone else sees them read-only. `rules` is null when the API could not answer; `apps` and
 * `channels` name ids (empty when unknown).
 */
export function RulesView({
  project,
  projectName,
  rules,
  apps,
  channels,
}: {
  project: string;
  projectName: string;
  rules: AlertRule[] | null;
  apps: Record<string, string>;
  channels: Record<string, string>;
}) {
  const manage = useCan("alerts.manage").allowed;
  const params = useSearchParams();
  const { rows: shown, window } = slicePage(rules ?? [], parsePage(params));
  return (
    <div className="page al">
      <AlertsHeader project={project} projectName={projectName} tab="rules" title="Alert rules" lead="Each rule watches one metric of one app and environment and opens an incident when it breaches its threshold.">
        {manage && rules !== null ? (
          <Link className="ah-btn ah-btn--primary ah-btn--sm" href={newRuleHref(project)}>
            New rule
          </Link>
        ) : null}
      </AlertsHeader>

      {manage ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>{READ_ONLY}</span>
        </p>
      )}
      {rules === null ? (
        <LoadFailed text={RULES_LOAD_FAILED} href={rulesHref(project)} />
      ) : rules.length === 0 ? (
        <Empty>
          No alert rules yet.{" "}
          {manage ? (
            <>
              Create one to be told when error rate, latency or traffic crosses a threshold. Notifications go to the{" "}
              <Link className="cp-link" href={channelsHref(project)}>
                alert channels
              </Link>{" "}
              you pick.
            </>
          ) : (
            "A project admin can create one."
          )}
        </Empty>
      ) : (
        <div className="al-card">
          <table className="al-table" aria-label="Alert rules">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Breaches when</th>
                <th scope="col">Checked</th>
                <th scope="col">Notifies</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <RuleRow key={r.id} project={project} rule={r} app={apps[r.app_id]} channels={channels} />
              ))}
            </tbody>
          </table>
          <Pagination pathname={rulesHref(project)} params={params} total={window.total} label="Alert rule pages" />
        </div>
      )}
    </div>
  );
}

function RuleRow({ project, rule: r, app, channels }: { project: string; rule: AlertRule; app: string | undefined; channels: Record<string, string> }) {
  const filters = [r.filters?.endpoint, r.filters?.consumer ? `consumer ${r.filters.consumer}` : "", r.filters?.group ? "one consumer group" : ""].filter(Boolean);
  const names = (r.channel_ids ?? []).map((id) => channels[id] ?? "Unknown channel");
  return (
    <tr>
      <td className="al-first">
        <Link className="al-name" href={ruleHref(project, r.id)}>
          {r.name}
        </Link>
        <span className="al-meta">
          {app ?? "Unknown app"} · {r.environment}
          {filters.length ? ` · ${filters.join(", ")}` : ""}
        </span>
      </td>
      <td data-label="Breaches when">{ruleSummary(r)}</td>
      <td data-label="Checked">
        {scheduleText(r)}
      </td>
      <td data-label="Notifies">{names.length ? names.join(", ") : <span className="al-muted">No channels</span>}</td>
      <td data-label="Status">
        {!r.enabled ? (
          <span className="ah-badge al-badge--none">Disabled</span>
        ) : r.state ? (
          <>
            <StatusBadge status={r.state.status} />
            <span className="al-meta al-mono">{formatMetric(r.metric, r.state.value)}</span>
          </>
        ) : (
          <span className="al-muted">Not evaluated yet</span>
        )}
      </td>
    </tr>
  );
}
