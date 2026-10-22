import Link from "next/link";

import type { ApiError } from "@/lib/api";
import { Code } from "./page";
import { Panel } from "./panel";

/** What is missing, and the one thing to do about it. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-start gap-1 px-4 py-8">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? <div className="max-w-prose text-sm text-muted-foreground">{children}</div> : null}
      {action ? (
        <Link href={action.href} className="focus-ring mt-2 rounded-sm text-sm text-brand-text underline-offset-4 hover:underline">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

const SEED = "docker compose run --rm --entrypoint /apilens apilens seed";

/** A specific, calm explanation of why data could not be loaded. */
export function ApiErrorState({ error }: { error: ApiError }) {
  const body = describe(error);
  return (
    <Panel className="border-danger/30" role="alert">
      <div className="flex flex-col gap-2 px-4 py-5">
        <p className="text-sm font-semibold text-foreground">{body.title}</p>
        <div className="max-w-prose text-sm text-muted-foreground">{body.text}</div>
        {body.command ? (
          <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-field px-3 py-2 font-mono text-xs text-foreground">
            {body.command}
          </pre>
        ) : null}
        {body.after ? <div className="max-w-prose text-sm text-muted-foreground">{body.after}</div> : null}
      </div>
    </Panel>
  );
}

function describe(error: ApiError): { title: string; text: React.ReactNode; command?: string; after?: React.ReactNode } {
  switch (error.kind) {
    case "unconfigured":
      return {
        title: "The console has no read key",
        text: (
          <>
            Set <Code>APILENS_READ_KEY</Code> to a key with the <Code>read</Code> scope. Create one (it also prints an
            ingest key for your SDKs):
          </>
        ),
        command: SEED,
        after: (
          <>
            Copy <Code>read_key</Code> into <Code>deploy/compose/.env</Code> as <Code>APILENS_READ_KEY</Code>, then restart
            the console with <Code>docker compose up -d console</Code>.
          </>
        ),
      };
    case "unauthorized":
      return {
        title: "The read key was rejected",
        text: (
          <>
            <Code>APILENS_READ_KEY</Code> is invalid, revoked, or lacks the <Code>read</Code> scope (ingest keys cannot read
            data). Issue a new one:
          </>
        ),
        command: SEED,
      };
    case "unreachable":
      return {
        title: "Cannot reach the APILens API",
        text: (
          <>
            Tried <Code>{error.baseUrl}</Code>. Check that the <Code>apilens</Code> service is running and that{" "}
            <Code>APILENS_API_URL</Code> points at it.
          </>
        ),
        command: "docker compose ps apilens",
      };
    case "not_found":
      return { title: "Not found", text: "The API has no record of this item." };
    default:
      return {
        title: `The API returned an error${error.status ? ` (HTTP ${error.status})` : ""}`,
        text: "This is not something you did. The server log has the details:",
        command: "docker compose logs --tail=100 apilens",
      };
  }
}
