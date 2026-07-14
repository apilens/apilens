"use client";

import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/reui/button";
import type { FrameworkId } from "@/types/app";

const FRAMEWORK_OPTIONS: Record<
  FrameworkId,
  { label: string; packageLanguage: "python" | "javascript"; installTarget: string }
> = {
  fastapi: { label: "FastAPI", packageLanguage: "python", installTarget: "fastapi" },
  flask: { label: "Flask", packageLanguage: "python", installTarget: "flask" },
  django: { label: "Django / Django Ninja", packageLanguage: "python", installTarget: "django" },
  starlette: { label: "Starlette", packageLanguage: "python", installTarget: "starlette" },
  express: { label: "Express", packageLanguage: "javascript", installTarget: "apilens-js-sdk" },
};

const PYTHON_KEYWORDS = new Set(["from", "import", "app", "True", "False", "None"]);

function buildFrameworkSnippet(
  framework: FrameworkId,
  apiKey: string,
  appSlug: string,
): string {
  // The API key is project-level, so setup needs just the key + which app it's
  // for (app_id). base_url defaults to https://ingest.apilens.ai/v1.
  if (framework === "express") {
    return `import express from "express";
import { useApiLens } from "apilens-js-sdk/express";

const app = express();
app.use(express.json());

useApiLens(app, {
  apiKey: "${apiKey}",   // project-level key
  appId: "${appSlug}",   // which app
});`;
  }
  if (framework === "fastapi") {
    return `from fastapi import FastAPI
from apilens.fastapi import ApiLensMiddleware

app = FastAPI()
app.add_middleware(
    ApiLensMiddleware,
    api_key="${apiKey}",   # project-level key
    app_id="${appSlug}",   # which app
)`;
  }
  if (framework === "flask") {
    return `from flask import Flask
from apilens import ApiLensClient, ApiLensConfig
from apilens.flask import instrument_app

app = Flask(__name__)
client = ApiLensClient(ApiLensConfig(api_key="${apiKey}"))
instrument_app(app, client, app_id="${appSlug}")`;
  }
  if (framework === "starlette") {
    return `from starlette.applications import Starlette
from apilens import ApiLensClient, ApiLensConfig
from apilens.starlette import instrument_app

app = Starlette()
client = ApiLensClient(ApiLensConfig(api_key="${apiKey}"))
instrument_app(app, client, app_id="${appSlug}")`;
  }
  return `# settings.py
MIDDLEWARE = [
    # ...
    "apilens.django.ApiLensDjangoMiddleware",
]

APILENS_API_KEY = "${apiKey}"   # project-level key
APILENS_APP_ID = "${appSlug}"   # which app`;
}

function buildInstallCommand(framework: FrameworkId): string {
  const option = FRAMEWORK_OPTIONS[framework];
  if (option.packageLanguage === "javascript") {
    return `npm install ${option.installTarget}`;
  }
  return `pip install "apilenss[${option.installTarget}]"`;
}

function tokenClass(token: string): string {
  if (token.startsWith("#")) return "comment";
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return "string";
  if (PYTHON_KEYWORDS.has(token)) return "keyword";
  if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) return "class";
  if (/^\d+(\.\d+)?$/.test(token)) return "number";
  return "plain";
}

function renderPythonLine(line: string): ReactNode[] {
  const regex = /#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\d+(?:\.\d+)?/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(line);

  while (match) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`txt-${lastIndex}`} className="code-token plain">{line.slice(lastIndex, match.index)}</span>);
    }
    const token = match[0];
    nodes.push(<span key={`tok-${match.index}`} className={`code-token ${tokenClass(token)}`}>{token}</span>);
    lastIndex = match.index + token.length;
    match = regex.exec(line);
  }

  if (lastIndex < line.length) {
    nodes.push(<span key={`txt-end-${lastIndex}`} className="code-token plain">{line.slice(lastIndex)}</span>);
  }
  if (nodes.length === 0) nodes.push(<span key="empty" className="code-token plain">&nbsp;</span>);
  return nodes;
}

function renderShellCode(code: string): ReactNode {
  const firstQuote = code.indexOf('"');
  const lastQuote = code.lastIndexOf('"');
  if (firstQuote !== -1 && lastQuote > firstQuote) {
    return (
      <>
        <span className="code-token keyword">{code.slice(0, firstQuote)}</span>
        <span className="code-token string">{code.slice(firstQuote, lastQuote + 1)}</span>
      </>
    );
  }
  return <span className="code-token plain">{code}</span>;
}

function CodeBlock({
  language,
  code,
  copied,
  onCopy,
}: {
  language: "bash" | "python" | "javascript";
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="create-app-codeblock">
      <div className="create-app-codeblock-head">
        <span>{language === "bash" ? "Terminal" : language === "python" ? "Python" : "JavaScript"}</span>
        <button type="button" className="create-app-copy-btn" onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="create-app-code">
        {code.split("\n").map((line, idx) => (
          <div key={`${language}-${idx}`} className="code-line">
            <span className="code-gutter">{idx + 1}</span>
            <span className="code-content">
              {language === "python" ? renderPythonLine(line) : language === "javascript" ? <span className="code-token plain">{line || "\u00A0"}</span> : renderShellCode(line)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SetupIdentifier({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <code className="block truncate font-mono text-[13px] text-foreground">{value}</code>
      </div>
      <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onCopy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export default function AppSetupGuide({
  appName,
  framework,
  apiKey,
  hasRawKey,
  appSlug,
  projectSlug,
  projectName,
}: {
  appName: string;
  framework: FrameworkId;
  apiKey: string;
  hasRawKey: boolean;
  appSlug: string;
  projectSlug?: string;
  projectName?: string;
}) {
  const [copiedItem, setCopiedItem] = useState<"install" | "snippet" | "project-slug" | "app-id" | "">("");
  const frameworkOption = FRAMEWORK_OPTIONS[framework] || FRAMEWORK_OPTIONS.fastapi;
  const installCmd = buildInstallCommand(framework);
  const projectLabel = projectName?.trim() || projectSlug;
  const projectSlugValue = projectSlug?.trim() || "your-project-slug";
  const snippet = buildFrameworkSnippet(framework, apiKey, appSlug);
  const snippetLanguage = frameworkOption.packageLanguage === "python" ? "python" : "javascript";

  const copyText = async (text: string, item: "install" | "snippet" | "project-slug" | "app-id") => {
    await navigator.clipboard.writeText(text);
    setCopiedItem(item);
    window.setTimeout(() => setCopiedItem(""), 1400);
  };

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">Quickstart</p>
        <h3 className="text-lg font-semibold leading-tight text-foreground">{appName} is live</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {frameworkOption.label} setup guide. Replace the masked API key below with the API key from{" "}
          {projectLabel ? <strong className="font-semibold text-foreground">{projectLabel}</strong> : "this project"}.{" "}
          {projectSlug && (
            <Link
              href={`/projects/${projectSlug}/settings/api-keys`}
              className="underline underline-offset-2 hover:text-foreground"
            >
              View API Keys
            </Link>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <div className="flex gap-3.5">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">1</div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h4 className="text-sm font-semibold text-foreground">Install package</h4>
            <p className="text-[13px] text-muted-foreground">Install the API Lens SDK package for {frameworkOption.label}.</p>
            <CodeBlock language="bash" code={installCmd} copied={copiedItem === "install"} onCopy={() => copyText(installCmd, "install")} />
          </div>
        </div>

        <div className="flex gap-3.5">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">2</div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h4 className="text-sm font-semibold text-foreground">Add middleware in app bootstrap</h4>
            <p className="text-[13px] text-muted-foreground">
              Paste this snippet in your entry file, keep these identifiers exactly as shown, and use a key from{" "}
              {projectLabel ? <strong className="font-semibold text-foreground">{projectLabel}</strong> : "the same project"}.
            </p>
            <div className="grid gap-2">
              <SetupIdentifier
                label="Project slug"
                value={projectSlugValue}
                copied={copiedItem === "project-slug"}
                onCopy={() => copyText(projectSlugValue, "project-slug")}
              />
              <SetupIdentifier
                label="App ID"
                value={appSlug}
                copied={copiedItem === "app-id"}
                onCopy={() => copyText(appSlug, "app-id")}
              />
            </div>
            <CodeBlock language={snippetLanguage} code={snippet} copied={copiedItem === "snippet"} onCopy={() => copyText(snippet, "snippet")} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/30 px-4 py-3.5">
          <p className="text-[13px] text-muted-foreground">After restarting your app, hit a few endpoints and open Endpoints to verify traffic.</p>
          <Button asChild className="shrink-0">
            <Link
              href={projectSlug ? `/projects/${projectSlug}/endpoints?app=${appSlug}` : `/apps/${appSlug}/endpoints`}
            >
              Continue to app
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
