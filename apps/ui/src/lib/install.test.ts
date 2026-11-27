import { describe, expect, it } from "vitest";
import {
  APP_NAME_COMMENT,
  KEY_PLACEHOLDER,
  type Posture,
  appIdFor,
  appNameNote,
  sdkBaseUrl,
  snippetsFor,
} from "./install";

const KEY = "apl_live_0123456789abcdef0123456789abcdef";
const base = { appId: "checkout", ingestUrl: "https://ingest.example.com", apiKey: KEY };
const code = (language: string, extra: Partial<typeof base> = {}) =>
  snippetsFor({ ...base, ...extra, language })
    .map((s) => s.code)
    .join("\n---\n");

describe("ingest URLs", () => {
  it("adds the SDK path to APILENS_PUBLIC_INGEST_URL", () => {
    expect(sdkBaseUrl("http://localhost:8080")).toBe("http://localhost:8080/v1");
    expect(sdkBaseUrl("https://ingest.example.com/")).toBe("https://ingest.example.com/v1");
  });

  it("uses the project slug as the app id", () => {
    expect(appIdFor("checkout")).toBe("checkout");
  });
});

describe("snippetsFor: SDK", () => {
  it("Python matches the README quick start (FastAPI middleware, base_url on the edge)", () => {
    const snippets = snippetsFor({ ...base, language: "python" });
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
    const out = code("node");
    expect(out).toContain("npm install apilens-js-sdk");
    expect(out).toContain('import { useApiLens } from "apilens-js-sdk/express";');
    expect(out).toContain("apiKey: process.env.APILENS_API_KEY,");
    expect(out).toContain('appId: "checkout",');
    expect(out).toContain('baseUrl: "https://ingest.example.com/v1",');
    expect(out).toContain(`export APILENS_API_KEY=${KEY}`);
  });

  it("Java matches the Java SDK README (Maven dependency, Spring properties)", () => {
    const out = code("java");
    expect(out).toContain("<artifactId>apilens-java-sdk</artifactId>");
    expect(out).toContain("apilens.api-key=${APILENS_API_KEY}");
    expect(out).toContain("apilens.app-id=checkout");
    expect(out).toContain("apilens.base-url=https://ingest.example.com/v1");
  });

  it("names the app in every SDK snippet, with the APILENS_APP_ID alternative and that it appears on first data", () => {
    expect(code("python")).toContain(`app_id="checkout",  # ${APP_NAME_COMMENT}`);
    expect(code("node")).toContain(`appId: "checkout", // ${APP_NAME_COMMENT}`);
    expect(code("java")).toContain(`# ${APP_NAME_COMMENT}\napilens.app-id=checkout`);
    expect(APP_NAME_COMMENT).toContain("APILENS_APP_ID");
    expect(appNameNote("checkout")).toBe(
      "The app name (checkout here) picks the app. It appears in Apps automatically when its first data arrives; name each service differently. Without a name, data goes to the project’s default app.",
    );
  });

  it("is empty for a language without an SDK", () => {
    expect(snippetsFor({ ...base, language: "go" })).toEqual([]);
  });
});

describe("snippetsFor: the key", () => {
  it("shows a placeholder once the raw key is gone, never a masked key", () => {
    const out = code("python", { apiKey: undefined });
    expect(out).toContain(`export APILENS_API_KEY=${KEY_PLACEHOLDER}`);
    expect(out).not.toContain(KEY);
    expect(code("node", { apiKey: "" })).toContain(KEY_PLACEHOLDER);
  });

  it("is empty for an unknown language", () => {
    expect(snippetsFor({ ...base, language: "cobol" })).toEqual([]);
    expect(snippetsFor({ ...base, language: undefined })).toEqual([]);
  });
});

describe("capture posture (#601)", () => {
  const sdk = (language: string, posture?: Posture) =>
    snippetsFor({ ...base, language, posture })
      .map((s) => s.code)
      .join("\n---\n");
  const ALL: Posture[] = ["metadata", "redacted", "full"];

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
});
