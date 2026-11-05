// "Install" onboarding step (#333): the ingest key it creates and the snippets it renders with that
// key for the language and method picked on the instrument step (#332). Pure, so every snippet
// can be unit tested against the SDK READMEs (packages/sdk-*) and the README quick start.
import type { ApiKey, ApiKeyScope } from "./identity";
import { type Method, languageOf } from "./instrument";

/** Name of the key the step creates, as it then shows in Project settings → API keys. */
export const INSTALL_KEY_NAME = "Onboarding";

/** What the key may do: send events, nothing else. */
export const INSTALL_KEY_SCOPES: readonly ApiKeyScope[] = ["ingest"];

/** `?setup=later`: the project page shows the "finish setting up" reminder (#333) for it. */
export const LATER_PARAM = "setup";
export const LATER_VALUE = "later";

/** What the snippets show in place of the key once the raw key is gone (it is never stored). */
export const KEY_PLACEHOLDER = "<your-ingest-key>";

/**
 * The `app_id` the snippets send. The edge maps it to an app of the key's project by slug; the
 * onboarding project's slug names the service being instrumented first.
 */
export function appIdFor(projectSlug: string): string {
  return projectSlug;
}

/** Where the SDKs send requests: the edge's `/v1` (the v1 wire format). */
export function sdkBaseUrl(ingestUrl: string): string {
  return `${ingestUrl.replace(/\/+$/, "")}/v1`;
}

/** Where OpenTelemetry exporters send traces and logs: the edge's `/otlp`. */
export function otlpEndpoint(ingestUrl: string): string {
  return `${ingestUrl.replace(/\/+$/, "")}/otlp`;
}

export interface Snippet {
  id: string;
  /** Shown in the code block's header. */
  title: string;
  code: string;
}

export interface SnippetInput {
  language: string | undefined;
  method: Method | undefined;
  /** The raw key while it is known; undefined renders {@link KEY_PLACEHOLDER}. */
  apiKey?: string;
  appId: string;
  /** `APILENS_PUBLIC_INGEST_URL`, no trailing slash. */
  ingestUrl: string;
}

/**
 * The Python SDK's `capture_profile` the snippet sets: `metadata` (no headers, bodies or validation
 * errors) is the documented first production rollout; the SDK's own default stays `full`.
 */
const PYTHON_CAPTURE_PROFILE = "metadata";

/** `export APILENS_API_KEY=…`: the key goes in the environment, never in source. */
function envSnippet(key: string): Snippet {
  return { id: "env", title: "Environment", code: `export APILENS_API_KEY=${key}` };
}

function sdkSnippets(language: string, key: string, appId: string, ingestUrl: string): Snippet[] {
  const baseUrl = sdkBaseUrl(ingestUrl);
  switch (language) {
    case "python":
      return [
        { id: "install", title: "Install", code: "pip install apilenss" },
        envSnippet(key),
        {
          id: "code",
          title: "main.py",
          code: [
            "import os",
            "from fastapi import FastAPI",
            "from apilens.fastapi import ApiLensMiddleware",
            "",
            "app = FastAPI()",
            "",
            "app.add_middleware(",
            "    ApiLensMiddleware,",
            '    api_key=os.environ["APILENS_API_KEY"],',
            `    app_id="${appId}",`,
            `    base_url="${baseUrl}",`,
            `    capture_profile="${PYTHON_CAPTURE_PROFILE}",  # metadata | redacted | full`,
            ")",
          ].join("\n"),
        },
      ];
    case "node":
      return [
        { id: "install", title: "Install", code: "npm install apilens-js-sdk" },
        envSnippet(key),
        {
          id: "code",
          title: "app.js",
          code: [
            'import express from "express";',
            'import { useApiLens } from "apilens-js-sdk/express";',
            "",
            "const app = express();",
            "app.use(express.json());",
            "",
            "useApiLens(app, {",
            "  apiKey: process.env.APILENS_API_KEY,",
            `  appId: "${appId}",`,
            `  baseUrl: "${baseUrl}",`,
            "});",
          ].join("\n"),
        },
      ];
    case "java":
      return [
        {
          id: "install",
          title: "pom.xml",
          code: [
            "<dependency>",
            "  <groupId>ai.apilens</groupId>",
            "  <artifactId>apilens-java-sdk</artifactId>",
            "  <version>0.1.0</version>",
            "</dependency>",
          ].join("\n"),
        },
        envSnippet(key),
        {
          id: "code",
          title: "application.properties",
          code: ["apilens.api-key=${APILENS_API_KEY}", `apilens.app-id=${appId}`, `apilens.base-url=${baseUrl}`].join("\n"),
        },
      ];
    default:
      return [];
  }
}

/**
 * The OpenTelemetry exporter environment for any language: OTLP/HTTP to the edge's `/otlp`, the
 * key as `X-API-Key`, and the app as the `apilens.app` resource attribute (`service.name` too, so
 * traces read well elsewhere). The edge takes traces and logs, not metrics.
 */
function otlpSnippets(key: string, appId: string, ingestUrl: string): Snippet[] {
  return [
    {
      id: "env",
      title: "Environment",
      code: [
        `export OTEL_EXPORTER_OTLP_ENDPOINT=${otlpEndpoint(ingestUrl)}`,
        "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
        `export OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${key}`,
        `export OTEL_SERVICE_NAME=${appId}`,
        `export OTEL_RESOURCE_ATTRIBUTES=apilens.app=${appId}`,
        "export OTEL_TRACES_EXPORTER=otlp",
        "export OTEL_LOGS_EXPORTER=otlp",
        "export OTEL_METRICS_EXPORTER=none",
      ].join("\n"),
    },
  ];
}

/** The snippets for `language` and `method`, in the order to follow them; empty when none apply. */
export function snippetsFor({ language, method, apiKey, appId, ingestUrl }: SnippetInput): Snippet[] {
  const lang = languageOf(language);
  if (!lang) return [];
  const key = apiKey || KEY_PLACEHOLDER;
  if (method === "sdk" && lang.sdk) return sdkSnippets(lang.id, key, appId, ingestUrl);
  if (method === "otlp" && lang.otlp) return otlpSnippets(key, appId, ingestUrl);
  return [];
}

/** The key the install step created, as the step reads it back once the raw key is gone. */
export type SavedKey = { state: "none" } | { state: "active"; prefix: string } | { state: "gone" } | { state: "unknown" };

/**
 * What became of the saved key `id` among the project's keys (`null` when they could not be
 * listed): none saved, still usable (only its prefix is known now), revoked, expired or deleted,
 * or unknown.
 */
export function savedKeyState(id: string | undefined, keys: readonly ApiKey[] | null, now = Date.now()): SavedKey {
  if (!id) return { state: "none" };
  if (!keys) return { state: "unknown" };
  const key = keys.find((k) => k.id === id);
  if (!key) return { state: "gone" };
  if (key.revoked_at) return { state: "gone" };
  if (key.expires_at) {
    const t = Date.parse(key.expires_at);
    if (!Number.isNaN(t) && t <= now) return { state: "gone" };
  }
  return { state: "active", prefix: key.prefix };
}

/** The sentence the install step shows when creating its key fails, by API error code. */
export function installKeyError(code: string): string {
  switch (code) {
    case "forbidden":
      return "You don’t have permission to create API keys in this project. Ask an owner or admin for one.";
    case "not_found":
      return "This project no longer exists, or you’re no longer a member.";
    case "rate_limited":
      return "Too many attempts in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens to create your key. Check your connection and try again.";
    default:
      return "We couldn’t create your key. Try again in a moment.";
  }
}
