// "Install" onboarding step (#333): the ingest key it creates and the snippets it renders with that
// key for the language and method picked on the instrument step (#332). Pure, so every snippet
// can be unit tested against the SDK READMEs (packages/sdk-*) and the README quick start.
import type { ApiKey, ApiKeyScope } from "./identity";
import { type Method, languageOf } from "./instrument";

/** Name of the key the step creates, as it then shows in Access → API keys. */
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
  /** The SDK's capture profile; undefined renders {@link DEFAULT_POSTURE}. OTLP snippets ignore it. */
  posture?: Posture;
}

/**
 * The SDKs' capture profiles (`capture_profile`, `captureProfile`, `apilens.capture-profile`,
 * `APILENS_CAPTURE_PROFILE`): what an SDK sends beyond the base record of method, route, status,
 * latency, sizes and consumer, which every profile sends.
 */
export type Posture = "metadata" | "redacted" | "full";

export interface PostureOption {
  id: Posture;
  label: string;
  /** One line on what choosing it means for the data that leaves the service. */
  consequence: string;
}

/** In the order the instrument step lists them, the documented first rollout first. */
export const POSTURES: readonly PostureOption[] = [
  {
    id: "metadata",
    label: "Metadata only",
    consequence: "No headers or bodies leave your service: method, route, status, latency, sizes and consumer only.",
  },
  {
    id: "redacted",
    label: "Redacted",
    consequence: "Headers and bodies up to 16 KB, with secrets and the fields listed in the snippet masked before they’re sent.",
  },
  {
    id: "full",
    label: "Full",
    consequence: "Headers and bodies up to the SDK’s cap; built-in masking still hides passwords, tokens and card numbers.",
  },
];

/** `metadata` is the documented first production rollout; the SDKs' own default stays `full`. */
export const DEFAULT_POSTURE: Posture = "metadata";

/** `?capture=` on the install step: the posture picked on the instrument step. */
export const POSTURE_PARAM = "capture";

/** The posture `value` names, or undefined for anything else. */
export function postureOf(value: string | string[] | null | undefined): Posture | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return POSTURES.find((p) => p.id === v)?.id;
}

/**
 * The starter redaction list every SDK snippet carries, on top of the SDKs' built-in masking
 * (passwords, tokens, secrets, card numbers): personal fields APIs commonly carry. Name regexes.
 */
export const STARTER_REDACT_QUERY_PARAMS: readonly string[] = ["^email$"];
export const STARTER_REDACT_BODY_FIELDS: readonly string[] = ["^email$", "^phone$", "^date_of_birth$"];

/** The docs page on what the SDKs capture and redact, at its capture profiles section. */
export function privacyDocsUrl(docs: string): string {
  return `${docs.replace(/\/+$/, "")}/getting-started/data-privacy#capture-profiles`;
}

/** `export APILENS_API_KEY=…`: the key goes in the environment, never in source. */
function envSnippet(key: string): Snippet {
  return { id: "env", title: "Environment", code: `export APILENS_API_KEY=${key}` };
}

/** The same posture and redaction list as environment variables, which every SDK reads. */
function postureEnvSnippet(posture: Posture): Snippet {
  return {
    id: "posture-env",
    title: "Or set the capture posture from the environment",
    code: [
      `export APILENS_CAPTURE_PROFILE=${posture}`,
      `export APILENS_REDACT_QUERY_PARAMS=${STARTER_REDACT_QUERY_PARAMS.join(",")}`,
      `export APILENS_REDACT_BODY_FIELDS=${STARTER_REDACT_BODY_FIELDS.join(",")}`,
    ].join("\n"),
  };
}

/** `"a", "b"` with `open` before each item (`r"` for Python raw strings). */
const quoted = (list: readonly string[], open: string) => list.map((x) => `${open}${x}"`).join(", ");

/** Next to the app name in every SDK snippet. */
export const APP_NAME_COMMENT = "or set APILENS_APP_ID; the app appears in APILens on its first data";

/**
 * Under the snippets: what the app name does. Apps come from the SDK: the first data with a new
 * name creates the app; data with no name goes to the project's default app.
 */
export function appNameNote(appId: string): string {
  return `The app name (${appId} here) picks the app. It appears in Apps automatically when its first data arrives; name each service differently. Without a name, data goes to the project’s default app.`;
}

const MASK_COMMENT = "Masked on top of the built-ins (passwords, tokens, card numbers).";

function sdkSnippets(language: string, key: string, appId: string, ingestUrl: string, posture: Posture): Snippet[] {
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
            `    app_id="${appId}",  # ${APP_NAME_COMMENT}`,
            `    base_url="${baseUrl}",`,
            `    capture_profile="${posture}",  # metadata | redacted | full`,
            `    # ${MASK_COMMENT}`,
            `    redact_query_params=[${quoted(STARTER_REDACT_QUERY_PARAMS, 'r"')}],`,
            `    redact_body_fields=[${quoted(STARTER_REDACT_BODY_FIELDS, 'r"')}],`,
            ")",
          ].join("\n"),
        },
        postureEnvSnippet(posture),
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
            `  appId: "${appId}", // ${APP_NAME_COMMENT}`,
            `  baseUrl: "${baseUrl}",`,
            `  captureProfile: "${posture}", // metadata | redacted | full`,
            `  // ${MASK_COMMENT}`,
            `  redactQueryParams: [${quoted(STARTER_REDACT_QUERY_PARAMS, '"')}],`,
            `  redactBodyFields: [${quoted(STARTER_REDACT_BODY_FIELDS, '"')}],`,
            "});",
          ].join("\n"),
        },
        postureEnvSnippet(posture),
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
          code: [
            "apilens.api-key=${APILENS_API_KEY}",
            `# ${APP_NAME_COMMENT}`,
            `apilens.app-id=${appId}`,
            `apilens.base-url=${baseUrl}`,
            "# metadata | redacted | full",
            `apilens.capture-profile=${posture}`,
            `# ${MASK_COMMENT}`,
            `apilens.redact-query-params=${STARTER_REDACT_QUERY_PARAMS.join(",")}`,
            `apilens.redact-body-fields=${STARTER_REDACT_BODY_FIELDS.join(",")}`,
          ].join("\n"),
        },
        postureEnvSnippet(posture),
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
        "# The app name: the app appears in APILens when its first data arrives.",
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
export function snippetsFor({ language, method, apiKey, appId, ingestUrl, posture = DEFAULT_POSTURE }: SnippetInput): Snippet[] {
  const lang = languageOf(language);
  if (!lang) return [];
  const key = apiKey || KEY_PLACEHOLDER;
  if (method === "sdk" && lang.sdk) return sdkSnippets(lang.id, key, appId, ingestUrl, posture);
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
