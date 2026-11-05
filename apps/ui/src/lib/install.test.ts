import { describe, expect, it } from "vitest";
import type { ApiKey } from "./identity";
import { KEY_PLACEHOLDER, appIdFor, installKeyError, otlpEndpoint, savedKeyState, sdkBaseUrl, snippetsFor } from "./install";

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
    expect(snippets.map((s) => s.id)).toEqual(["install", "env", "code"]);
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
    last_used_at: null,
    created_at: "2026-11-04T11:00:00Z",
    revoked_at: null,
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
