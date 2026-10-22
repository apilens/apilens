import Link from "next/link";
import type { Metadata } from "next";

import { MethodBadge, StatusCode } from "@/components/badge";
import { Filters } from "@/components/filters";
import { PageHeader } from "@/components/page";
import { Panel, PanelHeader } from "@/components/panel";
import { ApiErrorState, EmptyState } from "@/components/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { api, settle, type ErrorGroup } from "@/lib/api";
import { absoluteTime, formatCount, relativeTime } from "@/lib/format";
import { hrefWith, parseEnv, parseRange, rangeLong, type SearchParams } from "@/lib/params";

export const metadata: Metadata = { title: "Errors" };

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = parseRange(sp);
  const env = parseEnv(sp);
  const filters = { range, env };

  const [project, result] = await Promise.all([settle(api.project()), settle(api.errors(filters))]);
  const envs = project.ok ? project.data.environments : [];

  const header = (
    <PageHeader
      title="Errors"
      description={`Grouped by route and status · ${env ?? "All environments"} · ${rangeLong(range)}`}
      actions={<Filters pathname="/errors" current={filters} envs={envs} />}
    />
  );

  if (!result.ok) {
    return (
      <>
        {header}
        <ApiErrorState error={result.error} />
      </>
    );
  }

  const server = result.data.errors.filter((e) => e.status_code >= 500);
  const client = result.data.errors.filter((e) => e.status_code < 500);

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <ErrorPanel
          title="Server errors"
          description="5xx responses: something failed on your side"
          rows={server}
          status="5xx"
          filters={filters}
          empty={`No server errors in the ${rangeLong(range)}.`}
        />
        <ErrorPanel
          title="Client errors"
          description="4xx responses: requests your API rejected"
          rows={client}
          status="4xx"
          filters={filters}
          empty={`No client errors in the ${rangeLong(range)}.`}
        />
      </div>
    </>
  );
}

function ErrorPanel({
  title,
  description,
  rows,
  status,
  filters,
  empty,
}: {
  title: string;
  description: string;
  rows: ErrorGroup[];
  status: "4xx" | "5xx";
  filters: { range: string; env?: string };
  empty: string;
}) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  return (
    <Panel>
      <PanelHeader title={title} description={rows.length ? `${formatCount(total)} responses · ${description}` : description} />
      {rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Method</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Status</TableHead>
              <TableHead numeric>Count</TableHead>
              <TableHead numeric>Consumers</TableHead>
              <TableHead numeric>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={`${e.method} ${e.path} ${e.status_code}`}>
                <TableCell>
                  <MethodBadge method={e.method} />
                </TableCell>
                <TableCell mono className="max-w-md truncate">
                  <Link
                    href={hrefWith("/requests", filters, { path: e.path, status })}
                    className="focus-ring rounded-sm text-foreground underline-offset-4 hover:text-brand-text hover:underline"
                  >
                    {e.path}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusCode code={e.status_code} />
                </TableCell>
                <TableCell numeric>{formatCount(e.count)}</TableCell>
                <TableCell numeric>{formatCount(e.consumers)}</TableCell>
                <TableCell numeric tone="muted" title={absoluteTime(e.last_seen)}>
                  {relativeTime(e.last_seen)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
