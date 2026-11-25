import { RangePicker } from "@/components/range-picker";
import { RANGE_LABEL } from "@/lib/consumers";
import type { AppStatus, CapturePolicy, DeployChange, InstanceEvent, NamedApp, ResourceSeries, TrafficTimeseries } from "@/lib/identity";
import { projectSectionHref } from "@/lib/project-settings";
import {
  type ChartMarker,
  EVENTS_LOAD_FAILED,
  MEM_VIEW_LABEL,
  type MemView,
  RESOURCES_LOAD_FAILED,
  RESOURCE_RANGES,
  RUNTIME_LABEL,
  type ResourcesState,
  type RuntimeKind,
  chartMarkers,
  instanceWhere,
  isServerless,
  limitHint,
  resourcesEmpty,
  resourcesHref,
  seriesHasData,
  trafficOverlay,
} from "@/lib/resources";
import { ObIcon } from "../onboarding/ob";
import { InstancesTable } from "./instances-table";
import { ResourceChart } from "./resource-chart";
import { ResourcesPicker } from "./resources-picker";
import "../traffic/traffic.css";
import "./resources.css";

export interface RuntimeSeries {
  metric: string;
  label: string;
  /** Null when the API could not answer. */
  series: ResourceSeries | null;
}

export interface ResourcesTabProps {
  project: string;
  app: NamedApp;
  state: ResourcesState;
  status: AppStatus | null;
  policy: CapturePolicy | null;
  cpu: ResourceSeries | null;
  mem: ResourceSeries | null;
  throttled: ResourceSeries | null;
  runtime: RuntimeKind | null;
  runtimeSeries: RuntimeSeries[];
  events: InstanceEvent[] | null;
  deploys: DeployChange[] | null;
  traffic: TrafficTimeseries | null;
  now: number;
}

/**
 * The Resources tab of an app (M7 #1130, D15): is the app short of CPU or memory, which instance is
 * the outlier, is memory leaking, did a pod get OOMKilled, and does it line up with traffic? Scope
 * (range, environment, instance) and the CPU and memory views are in the URL. CPU % of the limit
 * (or absolute cores), memory (container working set against its limit, or process RSS / PSS) and
 * throttling, each an average with a min–max band over instances, requests per minute on a second
 * axis and restart / OOM / deploy markers; then the runtime panel and the instances table.
 */
export function ResourcesTab(p: ResourcesTabProps) {
  const { project, app, state, status } = p;
  const instances = status?.instances ?? [];
  const inScope = instances.filter((i) => !i.ended_at && (!state.env || i.environment === state.env) && (!state.instance || i.instance_id === state.instance));
  const hasData = seriesHasData(p.cpu?.points) || seriesHasData(p.mem?.points);
  const empty = resourcesEmpty(status, p.policy, hasData);
  const envs = [...new Set(instances.map((i) => i.environment).filter(Boolean))].sort();
  const instanceOptions = instances
    .filter((i) => !state.env || i.environment === state.env)
    .map((i) => ({ value: i.instance_id, label: `${instanceWhere(i) || i.instance_id}${instanceWhere(i) ? ` (${i.instance_id})` : ""}${i.ended_at ? ", ended" : ""}` }));
  const allServerless = inScope.length > 0 && inScope.every(isServerless);
  const someServerless = inScope.filter(isServerless).length;
  const markers: ChartMarker[] = chartMarkers(
    p.events?.filter((e) => (!state.instance || e.instance_id === state.instance) && (!state.container || e.container_id === state.container)) ?? null,
    p.deploys?.filter((d) => !state.env || !d.environment || d.environment === state.env) ?? null,
  );
  const overlay = (s: ResourceSeries | null) => (state.traffic && s ? trafficOverlay(s.points ?? [], p.traffic) : null);
  const hint = limitHint(inScope);
  const slug = app.slug;
  const href = (q: Partial<ResourcesState>) => resourcesHref(project, slug, { ...state, ...q });

  const toolbar = (
    <div className="tr-bar rs-bar">
      <div className="tr-bar__scope">
        <RangePicker options={RESOURCE_RANGES} value={state.range} href={(r) => href({ range: r })} />
        {envs.length > 0 ? (
          <ResourcesPicker
            project={project}
            app={slug}
            state={state}
            field="env"
            label="Environment"
            all="All environments"
            options={envs.map((e) => ({ value: e, label: e }))}
          />
        ) : null}
        {instanceOptions.length > 1 ? <ResourcesPicker project={project} app={slug} state={state} field="instance" label="Instance" all="All instances" options={instanceOptions} /> : null}
      </div>
      <nav className="tr-seg" aria-label="Traffic overlay">
        <a href={href({ traffic: true })} aria-current={state.traffic ? "page" : undefined}>
          Traffic on
        </a>
        <a href={href({ traffic: false })} aria-current={!state.traffic ? "page" : undefined}>
          Off
        </a>
      </nav>
    </div>
  );

  if (empty === "disabled") {
    return (
      <Notice title="Resource sampling is off for this app.">
        Its capture policy tells the SDKs not to sample CPU, memory or runtime health, so there is nothing to chart.{" "}
        <a className="cp-link" href={projectSectionHref(project, { slug: "capture" })}>
          Change the capture policy
        </a>
      </Notice>
    );
  }
  if (empty === "no_instances") {
    return (
      <Notice title={`No SDK instance of ${app.name} has sent a heartbeat yet.`}>
        CPU and memory arrive with every heartbeat, once a minute.{" "}
        <a className="cp-link" href={projectSectionHref(project, { slug: "sdk" })}>
          Set up the SDK
        </a>
      </Notice>
    );
  }
  if (empty === "old_sdk") {
    return (
      <>
        <Notice title="This app’s SDKs are too old to report resources.">
          No live instance runs an SDK release that samples CPU, memory and runtime health. Requests keep flowing meanwhile; upgrade the SDK and the charts fill from
          the next heartbeat.{" "}
          <a className="cp-link" href={projectSectionHref(project, { slug: "sdk" })}>
            Upgrade the SDK
          </a>
        </Notice>
        <section className="tr-card tr-card--table" aria-labelledby="rs-instances">
          <h2 id="rs-instances">SDK instances</h2>
          <InstancesTable project={project} app={slug} instances={instances} events={p.events} now={p.now} />
        </section>
      </>
    );
  }

  if (empty === "no_data") {
    return (
      <>
        {toolbar}
        <Notice title={`No resource samples in the last ${RANGE_LABEL[state.range]}.`}>
          The SDKs sample every 15 seconds and send the samples with their next heartbeat, so the first points show up within a minute or two of a process starting.
          {state.env || state.instance ? " Widen the environment or instance filter to see other instances." : ""}
        </Notice>
        <section className="tr-card tr-card--table" aria-labelledby="rs-instances">
          <h2 id="rs-instances">SDK instances</h2>
          <InstancesTable project={project} app={slug} instances={instances} events={p.events} now={p.now} />
        </section>
      </>
    );
  }

  return (
    <>
      {toolbar}
      {p.events === null ? <Failed text={EVENTS_LOAD_FAILED} /> : null}

      <section className="tr-card" aria-labelledby="rs-cpu">
        <div className="rs-card-head">
          <h2 id="rs-cpu">CPU</h2>
          {!allServerless ? (
            <nav className="tr-seg rs-seg" aria-label="CPU view">
              <a href={href({ cpu: "pct" })} aria-current={state.cpu === "pct" ? "page" : undefined}>
                % of limit
              </a>
              <a href={href({ cpu: "cores" })} aria-current={state.cpu === "cores" ? "page" : undefined}>
                Cores
              </a>
            </nav>
          ) : null}
        </div>
        {hint && !allServerless ? <p className="rs-hint">{hint}</p> : null}
        {allServerless ? (
          <p className="tr-empty" role="status">
            CPU is hidden for serverless instances: they only get CPU while handling a request, so a percentage would mislead. Memory and requests are below.
          </p>
        ) : p.cpu === null ? (
          <Failed text={RESOURCES_LOAD_FAILED} />
        ) : (
          <>
            <ResourceChart
              label={state.cpu === "pct" ? "CPU, % of limit" : "CPU, cores used"}
              series={p.cpu}
              range={state.range}
              markers={markers}
              overlay={overlay(p.cpu)}
              showLimit={state.cpu === "cores"}
              limitLabel="CPU limit"
            />
            {someServerless > 0 ? (
              <p className="rs-hint">
                {someServerless} serverless {someServerless === 1 ? "instance is" : "instances are"} left out of CPU.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="tr-card" aria-labelledby="rs-mem">
        <div className="rs-card-head">
          <h2 id="rs-mem">Memory</h2>
          <nav className="tr-seg rs-seg" aria-label="Memory view">
            {(Object.keys(MEM_VIEW_LABEL) as MemView[]).map((m) => (
              <a key={m} href={href({ mem: m })} aria-current={state.mem === m ? "page" : undefined}>
                {m === "working_set" ? "Container" : m === "rss" ? "RSS" : "PSS"}
              </a>
            ))}
          </nav>
        </div>
        <p className="rs-hint">
          {state.mem === "working_set"
            ? "The container’s working set (current minus inactive file cache), counted once per container however many workers it runs, against its limit."
            : state.mem === "rss"
              ? "Each process’s resident memory. Forked workers share pages, so RSS overstates their total; use Container for the number the OOM killer sees."
              : "Each process’s proportional share of the pages it shares with forked workers (Linux only, sampled every 60 seconds)."}
        </p>
        {p.mem === null ? (
          <Failed text={RESOURCES_LOAD_FAILED} />
        ) : (
          <ResourceChart
            label={`Memory, ${MEM_VIEW_LABEL[state.mem].toLowerCase()}`}
            series={p.mem}
            range={state.range}
            markers={markers}
            overlay={overlay(p.mem)}
            showLimit={state.mem === "working_set"}
            limitLabel="Memory limit"
          />
        )}
      </section>

      {!allServerless ? (
        <section className="tr-card" aria-labelledby="rs-throttle">
          <h2 id="rs-throttle">CPU throttling</h2>
          <p className="rs-hint">The share of scheduler periods in which the container hit its CPU quota and had to wait.</p>
          {p.throttled === null ? (
            <Failed text={RESOURCES_LOAD_FAILED} />
          ) : (
            <ResourceChart label="CPU throttling, share of periods" series={p.throttled} range={state.range} markers={markers} overlay={overlay(p.throttled)} />
          )}
        </section>
      ) : null}

      <RuntimePanel runtime={p.runtime} series={p.runtimeSeries} range={state.range} markers={markers} />

      <section className="tr-card tr-card--table" aria-labelledby="rs-instances">
        <h2 id="rs-instances">SDK instances</h2>
        {status === null ? <Failed text="We couldn’t load this app’s instances just now." /> : <InstancesTable project={project} app={slug} instances={instances} events={p.events} now={p.now} />}
      </section>
    </>
  );
}

/** The runtime panel (#1131): the app's runtime internals; hidden when no series has data. */
function RuntimePanel({ runtime, series, range, markers }: { runtime: RuntimeKind | null; series: RuntimeSeries[]; range: ResourcesState["range"]; markers: ChartMarker[] }) {
  const shown = series.filter((s) => s.series && seriesHasData(s.series.points));
  if (!runtime || shown.length === 0) return null;
  return (
    <section className="tr-card" aria-labelledby="rs-runtime">
      <h2 id="rs-runtime">{RUNTIME_LABEL[runtime]} runtime</h2>
      <div className="rs-runtime">
        {shown.map((s) => (
          <div key={s.metric} className="rs-runtime__item">
            <h3>{s.label}</h3>
            <ResourceChart label={s.label} series={s.series as ResourceSeries} range={range} markers={markers} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ap-notice rs-notice" role="status">
      <ObIcon name="info" />
      <div className="ap-notice__body">
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

function Failed({ text }: { text: string }) {
  return (
    <div className="ap-notice ap-notice--error" role="alert">
      <ObIcon name="info" />
      <p>{text}</p>
    </div>
  );
}
