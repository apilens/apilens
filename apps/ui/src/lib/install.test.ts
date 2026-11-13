import { describe, expect, it } from "vitest";
import type { ApiKey } from "./identity";
import {
  APP_NAME_COMMENT,
  DEFAULT_POSTURE,
  KEY_PLACEHOLDER,
  POSTURES,
  type Posture,
  appIdFor,
  appNameNote,
  installKeyError,
  otlpEndpoint,
  postureOf,
  privacyDocsUrl,
  savedKeyState,
  sdkBaseUrl,
  snippetsFor,
} from "./install";

const KEY = "apl_live_0123456789abcdef0123456789abcdef";
const base = { appId: "checkout", ingestUrl: "https://ingest.example.com", apiKey: KEY };
const code = (language: string, method: "sdk" | "otlp", extra: Partial<typeof base> = {}) =>
  snippetsFor({ ...base, ...extra, language, method })
    .map((s) => s.code)
    .join("\n---\n");

describe("ingest URLs", () => {
  it("adds the SDK and OTLP paths to APILENS_PUBLIC_INGEST_URL", () => {
    expect(sdkBaseUrl("http://localhost:8080")).toBe("http://localhost:8080/v1");
    expect(sdkBaseUrl("https://ingest.example.com/")).toBe("https://ingest.example.com/v1");
    expect(otlpEndpoint("http://localhost:8080")).toBe("http://localhost:8080/otlp");
  });

  it("uses the project slug as the app id", () => {
    expect(appIdFor("checkout")).toBe("checkout");
  });
});

describe("snippetsFor: SDK", () => {
  it("Python matches the README quick start (FastAPI middleware, base_url on the edge)", () => {
    const snippets = snippetsFor({ ...base, language: "python", method: "sdk" });
    expect(snippets.map((s) => s.id)).toEqual(["install", "env", "code", "posture-env"]);
    expect(snippets[0].code).toBe("pip install apilenss");
    expect(snippets[1].code).toBe(`export APILENS_API_KEY=${KEY}`);
    expect(snippets[2].code).toContain("from apilens.fastapi import ApiLensMiddleware");
    expect(snippets[2].code).toContain('api_key=os.environ["APILENS_API_KEY"],');
    expect(snippets[2].code).toContain('app_id="checkout",');
    expect(snippets[2].code).toContain('base_url="https://ingest.example.com/v1",');
    expect(snippets[2].code).toContain('capture_profile="metadata",  # metadata | redacted | full');
  });

  it("Node.js matches the TypeScript SDK README (Express useApiLens)", () => {
    const out = code("node", "sdk");
    expect(out).toContain("npm install apilens-js-sdk");
    expect(out).toContain('import { useApiLens } from "apilens-js-sdk/express";');
    expect(out).toContain("apiKey: process.env.APILENS_API_KEY,");
    expect(out).toContain('appId: "checkout",');
    expect(out).toContain('baseUrl: "https://ingest.example.com/v1",');
    expect(out).toContain(`export APILENS_API_KEY=${KEY}`);
  });

  it("Java matches the Java SDK README (Maven dependency, Spring properties)", () => {
    const out = code("java", "sdk");
    expect(out).toContain("<artifactId>apilens-java-sdk</artifactId>");
    expect(out).toContain("apilens.api-key=${APILENS_API_KEY}");
    expect(out).toContain("apilens.app-id=checkout");
    expect(out).toContain("apilens.base-url=https://ingest.example.com/v1");
  });

  it("names the app in every SDK snippet, with the APILENS_APP_ID alternative and that it appears on first data", () => {
    expect(code("python", "sdk")).toContain(`app_id="checkout",  # ${APP_NAME_COMMENT}`);
    expect(code("node", "sdk")).toContain(`appId: "checkout", // ${APP_NAME_COMMENT}`);
    expect(code("java", "sdk")).toContain(`# ${APP_NAME_COMMENT}\napilens.app-id=checkout`);
    expect(APP_NAME_COMMENT).toContain("APILENS_APP_ID");
    expect(code("node", "otlp")).toContain("# The app name: the app appears in APILens when its first data arrives.\nexport OTEL_SERVICE_NAME=checkout");
    expect(appNameNote("checkout")).toBe(
      "The app name (checkout here) picks the app. It appears in Apps automatically when its first data arrives; name each service differently. Without a name, data goes to the project’s default app.",
    );
  });

  it("is empty for a language without an SDK", () => {
    expect(snippetsFor({ ...base, language: "go", method: "sdk" })).toEqual([]);
  });
});

describe("snippetsFor: OTLP", () => {
  it.each(["python", "go", "dotnet", "ruby"])("%s gets the exporter environment for the edge", (language) => {
    const snippets = snippetsFor({ ...base, language, method: "otlp" });
    expect(snippets).toHaveLength(1);
    const env = snippets[0].code.split("\n");
    expect(env).toContain("export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.example.com/otlp");
    expect(env).toContain("export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf");
    expect(env).toContain(`export OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${KEY}`);
    expect(env).toContain("export OTEL_RESOURCE_ATTRIBUTES=apilens.app=checkout");
    expect(env).toContain("export OTEL_METRICS_EXPORTER=none");
  });

  it("is empty for a language without an OTLP path", () => {
    expect(snippetsFor({ ...base, language: "browser", method: "otlp" })).toEqual([]);
  });
});

describe("snippetsFor: the key", () => {
  it("shows a placeholder once the raw key is gone, never a masked key", () => {
    const out = code("python", "sdk", { apiKey: undefined });
    expect(out).toContain(`export APILENS_API_KEY=${KEY_PLACEHOLDER}`);
    expect(out).not.toContain(KEY);
    expect(code("node", "otlp", { apiKey: "" })).toContain(`x-api-key=${KEY_PLACEHOLDER}`);
  });

  it("is empty for an unknown language or method", () => {
    expect(snippetsFor({ ...base, language: "cobol", method: "sdk" })).toEqual([]);
    expect(snippetsFor({ ...base, language: "python", method: "url-check" })).toEqual([]);
    expect(snippetsFor({ ...base, language: undefined, method: undefined })).toEqual([]);
  });
});

describe("savedKeyState", () => {
  const ID = "0b6f5c7e-8d1a-4c2b-9e3f-1a2b3c4d5e6f";
  const NOW = Date.parse("2026-11-04T12:00:00Z");
  const key = (over: Partial<ApiKey> = {}): ApiKey => ({
    id: ID,
    name: "Onboarding",
    prefix: "apl_live_0123",
    scopes: ["ingest"],
    can_create_apps: true,
    app_ids: null,
    apps_seen: [],
    last_used_at: null,
    created_at: "2026-11-04T11:00:00Z",
    expires_at: null,
    revoked_at: null,
    environments: null,
    last_used_ip: null,
    last_used_sdk: null,
    rate_limit_per_minute: null,
    rotated_from: null,
    rotated_to: null,
    ...over,
  });

  it("is none when no key was saved", () => {
    expect(savedKeyState(undefined, [key()], NOW)).toEqual({ state: "none" });
  });

  it("knows only the prefix of a key still in use", () => {
    expect(savedKeyState(ID, [key()], NOW)).toEqual({ state: "active", prefix: "apl_live_0123" });
    expect(savedKeyState(ID, [key({ expires_at: "2026-12-01T00:00:00Z" })], NOW)).toEqual({ state: "active", prefix: "apl_live_0123" });
  });

  it("is gone when the key was revoked, expired or deleted", () => {
    expect(savedKeyState(ID, [key({ revoked_at: "2026-11-04T11:30:00Z" })], NOW)).toEqual({ state: "gone" });
    expect(savedKeyState(ID, [key({ expires_at: "2026-11-04T11:59:59Z" })], NOW)).toEqual({ state: "gone" });
    expect(savedKeyState(ID, [], NOW)).toEqual({ state: "gone" });
  });

  it("is unknown when the keys could not be listed", () => {
    expect(savedKeyState(ID, null, NOW)).toEqual({ state: "unknown" });
  });
});

describe("installKeyError", () => {
  it("answers a sentence per code", () => {
    expect(installKeyError("forbidden")).toContain("permission");
    expect(installKeyError("unavailable")).toContain("reach APILens");
    expect(installKeyError("whatever")).toBe("We couldn’t create your key. Try again in a moment.");
  });
});

describe("capture posture (#601)", () => {
  const sdk = (language: string, posture?: Posture) =>
    snippetsFor({ ...base, language, method: "sdk", posture })
      .map((s) => s.code)
      .join("\n---\n");
  const ALL: Posture[] = ["metadata", "redacted", "full"];

  it("offers metadata, redacted and full, each with a one-line consequence, metadata by default", () => {
    expect(POSTURES.map((p) => p.id)).toEqual(ALL);
    for (const p of POSTURES) expect(p.consequence).not.toContain("\n");
    expect(DEFAULT_POSTURE).toBe("metadata");
  });

  it("reads only known postures from ?capture=", () => {
    expect(postureOf("redacted")).toBe("redacted");
    expect(postureOf(["full", "metadata"])).toBe("full");
    expect(postureOf("everything")).toBeUndefined();
    expect(postureOf(undefined)).toBeUndefined();
  });

  it.each(ALL)("Python sets capture_profile=%s, the starter redaction list and the env-var form", (posture) => {
    const out = sdk("python", posture);
    expect(out).toContain(`capture_profile="${posture}",  # metadata | redacted | full`);
    expect(out).toContain('redact_query_params=[r"^email$"],');
    expect(out).toContain('redact_body_fields=[r"^email$", r"^phone$", r"^date_of_birth$"],');
    expect(out).toContain(`export APILENS_CAPTURE_PROFILE=${posture}`);
    expect(out).toContain("export APILENS_REDACT_QUERY_PARAMS=^email$");
    expect(out).toContain("export APILENS_REDACT_BODY_FIELDS=^email$,^phone$,^date_of_birth$");
  });

  it.each(ALL)("Node.js sets captureProfile %s, the starter redaction list and the env-var form", (posture) => {
    const out = sdk("node", posture);
    expect(out).toContain(`captureProfile: "${posture}", // metadata | redacted | full`);
    expect(out).toContain('redactQueryParams: ["^email$"],');
    expect(out).toContain('redactBodyFields: ["^email$", "^phone$", "^date_of_birth$"],');
    expect(out).toContain(`export APILENS_CAPTURE_PROFILE=${posture}`);
    expect(out).toContain("export APILENS_REDACT_BODY_FIELDS=^email$,^phone$,^date_of_birth$");
  });

  it.each(ALL)("Java sets apilens.capture-profile=%s, the starter redaction list and the env-var form", (posture) => {
    const out = sdk("java", posture);
    expect(out).toContain(`apilens.capture-profile=${posture}`);
    expect(out).toContain("apilens.redact-query-params=^email$");
    expect(out).toContain("apilens.redact-body-fields=^email$,^phone$,^date_of_birth$");
    expect(out).toContain(`export APILENS_CAPTURE_PROFILE=${posture}`);
    expect(out).toContain("export APILENS_REDACT_QUERY_PARAMS=^email$");
  });

  it("defaults the snippets to metadata", () => {
    expect(sdk("python")).toContain('capture_profile="metadata"');
    expect(sdk("node")).toContain('captureProfile: "metadata"');
    expect(sdk("java")).toContain("apilens.capture-profile=metadata");
  });

  it("leaves OpenTelemetry snippets alone: the posture is an SDK setting", () => {
    const out = snippetsFor({ ...base, language: "python", method: "otlp", posture: "full" })
      .map((s) => s.code)
      .join("\n");
    expect(out).not.toContain("APILENS_CAPTURE_PROFILE");
  });

  it("links the docs' data privacy page at its capture profiles", () => {
    expect(privacyDocsUrl("https://apilens.ai/docs")).toBe("https://apilens.ai/docs/getting-started/data-privacy#capture-profiles");
    expect(privacyDocsUrl("https://docs.example.com/")).toBe("https://docs.example.com/getting-started/data-privacy#capture-profiles");
  });
});
