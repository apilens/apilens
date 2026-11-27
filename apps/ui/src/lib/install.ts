// The SDK install snippets, rendered with an ingest key for a language (SDK setup, consumers and
// deploys pages). Pure, so every snippet can be unit tested against the SDK READMEs
// (packages/sdk-*) and the README quick start.
import { languageOf } from "./instrument";

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

export interface Snippet {
  id: string;
  /** Shown in the code block's header. */
  title: string;
  code: string;
}

export interface SnippetInput {
  language: string | undefined;
  /** The raw key while it is known; undefined renders {@link KEY_PLACEHOLDER}. */
  apiKey?: string;
  appId: string;
  /** `APILENS_PUBLIC_INGEST_URL`, no trailing slash. */
  ingestUrl: string;
  /** The SDK's capture profile; undefined renders {@link DEFAULT_POSTURE}. */
  posture?: Posture;
}

/**
 * The SDKs' capture profiles (`capture_profile`, `captureProfile`, `apilens.capture-profile`,
 * `APILENS_CAPTURE_PROFILE`): what an SDK sends beyond the base record of method, route, status,
 * latency, sizes and consumer, which every profile sends.
 */
export type Posture = "metadata" | "redacted" | "full";

/** `metadata` is the documented first production rollout; the SDKs' own default stays `full`. */
export const DEFAULT_POSTURE: Posture = "metadata";

/**
 * The starter redaction list every SDK snippet carries, on top of the SDKs' built-in masking
 * (passwords, tokens, secrets, card numbers): personal fields APIs commonly carry. Name regexes.
 */
export const STARTER_REDACT_QUERY_PARAMS: readonly string[] = ["^email$"];
export const STARTER_REDACT_BODY_FIELDS: readonly string[] = ["^email$", "^phone$", "^date_of_birth$"];

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

/** The SDK snippets for `language`, in the order to follow them; empty for a language without one. */
export function snippetsFor({ language, apiKey, appId, ingestUrl, posture = DEFAULT_POSTURE }: SnippetInput): Snippet[] {
  const lang = languageOf(language);
  if (!lang) return [];
  return sdkSnippets(lang.id, apiKey || KEY_PLACEHOLDER, appId, ingestUrl, posture);
}
