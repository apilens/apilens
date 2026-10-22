import type { Metadata } from "next";

import { Badge } from "@/components/badge";
import { CopyButton } from "@/components/client";
import { Code, PageHeader } from "@/components/page";
import { Panel, PanelBody, PanelHeader } from "@/components/panel";
import { ApiErrorState } from "@/components/states";
import { api, publicIngestUrl, settle } from "@/lib/api";

export const metadata: Metadata = { title: "Setup" };

function Snippet({ title, language, code }: { title: string; language: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-field">
      <div className="flex h-9 items-center justify-between border-b border-border pr-1 pl-3">
        <span className="text-xs font-medium text-muted-foreground">
          {title} <span className="text-subtle-foreground">· {language}</span>
        </span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-5 text-foreground">{code}</pre>
    </div>
  );
}

export default async function SetupPage() {
  const project = await settle(api.project());
  const ingest = publicIngestUrl();

  if (!project.ok) {
    return (
      <>
        <PageHeader title="Setup" description="Connect an app to this project" />
        <ApiErrorState error={project.error} />
      </>
    );
  }

  const apps = project.data.apps;
  const app = apps[0]?.slug ?? "your-app";

  const python = `pip install apilenss

# main.py
import os
from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware

app = FastAPI()
app.add_middleware(
    ApiLensMiddleware,
    api_key=os.environ["APILENS_API_KEY"],
    app_id="${app}",
    base_url="${ingest}/v1",
)`;

  const node = `npm install apilens-js-sdk

// server.js
import express from "express";
import { useApiLens } from "apilens-js-sdk/express";

const app = express();
useApiLens(app, {
  apiKey: process.env.APILENS_API_KEY,
  appId: "${app}",
  baseUrl: "${ingest}/v1",
});`;

  const otel = `export OTEL_EXPORTER_OTLP_ENDPOINT="${ingest}/otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="X-API-Key=$APILENS_API_KEY"
export OTEL_SERVICE_NAME="${app}"`;

  return (
    <>
      <PageHeader title="Setup" description={`Connect an app to ${project.data.project.name}`} />
      <div className="flex max-w-3xl flex-col gap-4">
        <Panel>
          <PanelHeader title="1. Get an ingest key" />
          <PanelBody className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              Ingest keys are project-scoped and can only send data. Create one on the server and keep it in your app&apos;s
              environment as <Code>APILENS_API_KEY</Code>:
            </p>
            <pre className="overflow-x-auto rounded-md border border-border bg-field px-3 py-2 font-mono text-xs text-foreground">
              docker compose run --rm --entrypoint /apilens apilens seed
            </pre>
            <p>
              Use <Code>api_key</Code> from the output in your apps. <Code>read_key</Code> is for this console only. Keys are
              shown once and never displayed here.
            </p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="2. Pick the app" description="Traffic is attributed to the app slug you send" />
          <PanelBody className="flex flex-wrap items-center gap-2">
            {apps.length ? (
              apps.map((a) => (
                <Badge key={a.id} mono>
                  {a.slug}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">This project has no apps yet. Seed one with <Code>-app-slug</Code>.</span>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="3. Instrument it" description={`Ingest endpoint ${ingest}`} />
          <PanelBody className="flex flex-col gap-3">
            <Snippet title="Python" language="FastAPI" code={python} />
            <Snippet title="Node.js" language="Express" code={node} />
            <Snippet title="OpenTelemetry" language="any language, OTLP/HTTP" code={otel} />
            <p className="text-sm text-muted-foreground">
              Requests show up on Traffic within a second. OpenTelemetry services are matched to apps by{" "}
              <Code>service.name</Code> (or the <Code>apilens.app</Code> resource attribute).
            </p>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}
