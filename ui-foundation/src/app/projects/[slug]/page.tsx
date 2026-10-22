import { EnvBadge } from "@/components/patterns/env-badge";
import { Gated } from "@/components/patterns/gated";
import { LiveIndicator } from "@/components/patterns/live-indicator";
import { PageHeader } from "@/components/patterns/page-header";
import { Sparkline } from "@/components/patterns/sparkline";
import { StatRow, StatTile } from "@/components/patterns/stat-tile";
import { EmptyState } from "@/components/patterns/states";
import { TimeRangePicker } from "@/components/patterns/time-range-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BellIcon, PlusIcon } from "@/components/ui/icon";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusDot } from "@/components/ui/status-dot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEMO_NOW, ENDPOINTS, KPIS, projectBySlug } from "@/lib/demo-data";
import { formatCount, formatDuration, formatPercent, formatRelative, formatTimestamp } from "@/lib/format";

export default async function OverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = projectBySlug(slug);
  const lastEvent = new Date(DEMO_NOW.getTime() - 12_000);

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Traffic, errors and latency for ${project.name}.`}
        meta={
          <>
            <EnvBadge env="production" />
            <LiveIndicator />
          </>
        }
        actions={<TimeRangePicker />}
      />

      <StatRow className="mb-6">
        <StatTile label="Requests" value={formatCount(KPIS.requests.value)} delta={KPIS.requests.delta} trend={KPIS.requests.trend} />
        <StatTile
          label="Client errors (4xx)"
          value={formatPercent(KPIS.clientErrors.value)}
          delta={KPIS.clientErrors.delta}
          upIsGood={false}
          trend={KPIS.clientErrors.trend}
        />
        <StatTile
          label="Server errors (5xx)"
          value={formatPercent(KPIS.serverErrors.value)}
          delta={KPIS.serverErrors.delta}
          upIsGood={false}
          trend={KPIS.serverErrors.trend}
        />
        <StatTile label="p95 latency" value={formatDuration(KPIS.p95.value)} delta={KPIS.p95.delta} upIsGood={false} trend={KPIS.p95.trend} />
      </StatRow>

      <Panel className="mb-6">
        <PanelHeader
          title="Endpoints"
          description="Sorted by requests, last 24 hours"
          actions={
            <Button variant="ghost" size="sm">
              View all endpoints
            </Button>
          }
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead numeric>Requests</TableHead>
              <TableHead numeric>4xx</TableHead>
              <TableHead numeric>5xx</TableHead>
              <TableHead numeric>p95</TableHead>
              <TableHead className="w-28">Trend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENDPOINTS.map((e) => (
              <TableRow key={`${e.method} ${e.path}`}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <Badge mono className="w-14 justify-center">
                      {e.method}
                    </Badge>
                    <span className="truncate font-mono text-xs">{e.path}</span>
                  </span>
                </TableCell>
                <TableCell numeric>{formatCount(e.requests)}</TableCell>
                <TableCell numeric tone={e.clientErrorRate >= 0.02 ? "warning" : "default"}>
                  {formatPercent(e.clientErrorRate)}
                </TableCell>
                <TableCell numeric tone={e.serverErrorRate >= 0.01 ? "danger" : "default"}>
                  {formatPercent(e.serverErrorRate)}
                </TableCell>
                <TableCell numeric tone={e.p95Ms >= 1000 ? "warning" : "default"}>
                  {formatDuration(e.p95Ms)}
                </TableCell>
                <TableCell>
                  <Sparkline points={e.trend} label={`Requests trend for ${e.method} ${e.path}`} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Alerts" description="Rules that notify your team when a threshold is crossed" />
          <EmptyState
            icon={<BellIcon />}
            title="No alert rules yet"
            description="Get notified in Slack or by email when server errors or p95 latency cross a threshold you set."
            action={
              <Gated action="project.update">
                <Button variant="primary">
                  <PlusIcon />
                  Create alert rule
                </Button>
              </Gated>
            }
          />
        </Panel>

        <Panel>
          <PanelHeader title="Ingestion" description="SDK health for this environment" />
          <dl className="divide-y divide-border text-sm">
            <div className="flex h-10 items-center justify-between px-4">
              <dt className="text-muted-foreground">SDK</dt>
              <dd>
                <StatusDot status="success" label="Connected · apilenss 0.4.0" />
              </dd>
            </div>
            <div className="flex h-10 items-center justify-between px-4">
              <dt className="text-muted-foreground">Last event</dt>
              <dd>
                <time dateTime={lastEvent.toISOString()} title={formatTimestamp(lastEvent)} className="tabular-nums">
                  {formatRelative(lastEvent, DEMO_NOW)}
                </time>
              </dd>
            </div>
            <div className="flex h-10 items-center justify-between px-4">
              <dt className="text-muted-foreground">Dropped events</dt>
              <dd className="tabular-nums">0</dd>
            </div>
            <div className="flex h-10 items-center justify-between px-4">
              <dt className="text-muted-foreground">PII redaction</dt>
              <dd>
                <StatusDot status="info" label="3 rules active" />
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </>
  );
}
