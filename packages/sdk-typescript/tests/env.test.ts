import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiLensClient } from "../src/client.js";
import {
  CAPTURE_PROFILES,
  ENV_OPTIONS,
  REDACTED_PROFILE_MAX_PAYLOAD_BYTES,
  applyCaptureProfile,
  envVar,
  loadEnvConfig,
  resolveConfig,
} from "../src/env.js";
import { useApiLens } from "../src/express.js";
import type { ApiLensExpressConfig } from "../src/types.js";

const saved: Record<string, string | undefined> = {};

function clearApilensEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("APILENS_")) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  }
}

beforeEach(() => {
  clearApilensEnv();
});

afterEach(async () => {
  clearApilensEnv();
  for (const [name, value] of Object.entries(saved)) {
    if (value !== undefined) {
      process.env[name] = value;
    }
    delete saved[name];
  }
  await ApiLensClient.shutdown();
});

describe("loadEnvConfig", () => {
  it("uses the same variable names as the Python SDK", () => {
    expect(ENV_OPTIONS.map((o) => envVar(o.option))).toEqual([
      "APILENS_API_KEY",
      "APILENS_APP_ID",
      "APILENS_ENVIRONMENT",
      "APILENS_BASE_URL",
      "APILENS_ENABLED",
      "APILENS_CAPTURE_PROFILE",
      "APILENS_CAPTURE_HEADERS",
      "APILENS_CAPTURE_PAYLOADS",
      "APILENS_LOG_REQUEST_BODY",
      "APILENS_LOG_RESPONSE_BODY",
      "APILENS_MAX_PAYLOAD_BYTES",
      "APILENS_CAPTURE_CONTENT_TYPES",
      "APILENS_REDACT_QUERY_PARAMS",
      "APILENS_REDACT_HEADERS",
      "APILENS_REDACT_BODY_FIELDS",
      "APILENS_EXCLUDE_PATHS",
      "APILENS_EXCLUDE_USER_AGENTS",
      "APILENS_DEFAULT_EXCLUSIONS",
      "APILENS_SAMPLE_RATE",
      "APILENS_BATCH_SIZE",
      "APILENS_FLUSH_INTERVAL",
    ]);
  });

  it("parses every type and skips unset or empty variables", () => {
    const config = loadEnvConfig({
      APILENS_API_KEY: "  key-1 ",
      APILENS_APP_ID: "",
      APILENS_ENABLED: "Off",
      APILENS_CAPTURE_HEADERS: "YES",
      APILENS_MAX_PAYLOAD_BYTES: "2048",
      APILENS_REDACT_HEADERS: "^x-secret$, ,^x-tenant$",
      APILENS_SAMPLE_RATE: "0.25",
      APILENS_FLUSH_INTERVAL: "1.5",
      APILENS_CAPTURE_PROFILE: "Metadata",
      APILENS_UNKNOWN: "ignored",
    });
    expect(config).toEqual({
      apiKey: "key-1",
      enabled: false,
      captureHeaders: true,
      maxPayloadBytes: 2048,
      redactHeaders: ["^x-secret$", "^x-tenant$"],
      sampleRate: 0.25,
      flushIntervalMs: 1500,
      captureProfile: "metadata",
    });
  });

  it.each([
    ["APILENS_ENABLED", "maybe", /APILENS_ENABLED: expected a boolean/],
    ["APILENS_BATCH_SIZE", "1.5", /APILENS_BATCH_SIZE: expected an integer/],
    ["APILENS_SAMPLE_RATE", "abc", /APILENS_SAMPLE_RATE: expected a finite number/],
    ["APILENS_FLUSH_INTERVAL", "Infinity", /APILENS_FLUSH_INTERVAL: expected a finite number/],
    ["APILENS_CAPTURE_PROFILE", "everything", /APILENS_CAPTURE_PROFILE: expected one of/],
  ])("throws naming %s for an unparseable value", (name, value, message) => {
    expect(() => loadEnvConfig({ [name]: value })).toThrow(message);
  });
});

describe("resolveConfig precedence", () => {
  it("explicit option > env var > default", () => {
    const env = {
      APILENS_API_KEY: "env-key",
      APILENS_APP_ID: "env-app",
      APILENS_ENVIRONMENT: "staging",
      APILENS_SAMPLE_RATE: "0.5",
      APILENS_LOG_REQUEST_BODY: "false",
      APILENS_MAX_PAYLOAD_BYTES: "1024",
    };
    const resolved = resolveConfig<ApiLensExpressConfig>(
      {
        apiKey: "code-key",
        sampleRate: 0.1,
        requestLogging: { maxPayloadBytes: 4096 },
      },
      env,
    );
    // explicit wins
    expect(resolved.apiKey).toBe("code-key");
    expect(resolved.sampleRate).toBe(0.1);
    expect(resolved.requestLogging?.maxPayloadBytes).toBe(4096);
    // env fills what code left unset
    expect(resolved.appId).toBe("env-app");
    expect(resolved.environment).toBe("staging");
    expect(resolved.requestLogging?.logRequestBody).toBe(false);
    // nothing set anywhere stays at the default (undefined → component default)
    expect(resolved.batchSize).toBeUndefined();
    expect(resolved.requestLogging?.captureHeaders).toBeUndefined();
  });

  it("treats every alias as explicit", () => {
    const env = { APILENS_API_KEY: "env-key", APILENS_ENVIRONMENT: "staging", APILENS_BASE_URL: "https://env" };
    const resolved = resolveConfig<ApiLensExpressConfig>(
      { client_id: "code-key", env: "dev", base_url: "https://code" },
      env,
    );
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.environment).toBeUndefined();
    expect(resolved.baseUrl).toBeUndefined();
  });

  it("explicit false and 0 are explicit, not unset", () => {
    const resolved = resolveConfig<ApiLensExpressConfig>(
      { enabled: false, sampleRate: 0, requestLogging: { captureHeaders: false } },
      { APILENS_ENABLED: "true", APILENS_SAMPLE_RATE: "1", APILENS_CAPTURE_HEADERS: "true" },
    );
    expect(resolved.enabled).toBe(false);
    expect(resolved.sampleRate).toBe(0);
    expect(resolved.requestLogging?.captureHeaders).toBe(false);
  });

  it("appends APILENS_EXCLUDE_USER_AGENTS and leaves APILENS_EXCLUDE_PATHS to the excluder", () => {
    const resolved = resolveConfig<ApiLensExpressConfig>(
      { excludeUserAgents: ["uptimerobot"], excludePaths: ["^/internal/"] },
      { APILENS_EXCLUDE_USER_AGENTS: "pingdom,statuscake", APILENS_EXCLUDE_PATHS: "^/env/" },
    );
    expect(resolved.excludeUserAgents).toEqual(["uptimerobot", "pingdom", "statuscake"]);
    expect(resolved.excludePaths).toEqual(["^/internal/"]);
  });

  it("does not mutate the input", () => {
    const input: ApiLensExpressConfig = { requestLogging: {} };
    resolveConfig(input, { APILENS_CAPTURE_PROFILE: "metadata", APILENS_APP_ID: "x" });
    expect(input).toEqual({ requestLogging: {} });
  });

  it("feeds the client: env fills unset options, explicit options win", () => {
    process.env.APILENS_API_KEY = "env-key";
    process.env.APILENS_APP_ID = "env-app";
    process.env.APILENS_BATCH_SIZE = "7";
    process.env.APILENS_FLUSH_INTERVAL = "2";
    const client = new ApiLensClient({ appId: "code-app", fetchImpl: async () => new Response(null) });
    client.stop();
    expect(client.config.apiKey).toBe("env-key");
    expect(client.config.appId).toBe("code-app");
    expect(client.config.batchSize).toBe(7);
    expect(client.config.flushIntervalMs).toBe(2000);
  });

  it("throws at construction for an invalid env value", () => {
    process.env.APILENS_BATCH_SIZE = "lots";
    expect(() => new ApiLensClient({ apiKey: "k" })).toThrow(/APILENS_BATCH_SIZE/);
  });
});

describe("captureProfile", () => {
  it("presets match the documented postures", () => {
    expect(CAPTURE_PROFILES.metadata).toEqual({
      captureHeaders: false,
      logRequestBody: false,
      logResponseBody: false,
    });
    expect(CAPTURE_PROFILES.redacted).toEqual({
      captureHeaders: true,
      capturePayloads: true,
      logRequestBody: true,
      logResponseBody: true,
      maxPayloadBytes: 16 * 1024,
    });
    expect(CAPTURE_PROFILES.full).toEqual({});
    expect(REDACTED_PROFILE_MAX_PAYLOAD_BYTES).toBe(16384);
  });

  it("explicit flags win over the preset", () => {
    expect(applyCaptureProfile("metadata", { captureHeaders: true })).toEqual({
      captureHeaders: true,
      logRequestBody: false,
      logResponseBody: false,
    });
    expect(applyCaptureProfile("redacted", { maxPayloadBytes: 1024 }).maxPayloadBytes).toBe(1024);
  });

  it("capturePayloads: true under metadata asks for both bodies", () => {
    expect(applyCaptureProfile("metadata", { capturePayloads: true })).toEqual({
      capturePayloads: true,
      captureHeaders: false,
    });
  });

  it("an env flag wins over a preset given in code; the code preset wins over env profile", () => {
    const resolved = resolveConfig<ApiLensExpressConfig>(
      { captureProfile: "metadata" },
      { APILENS_CAPTURE_HEADERS: "true", APILENS_CAPTURE_PROFILE: "full" },
    );
    expect(resolved.captureProfile).toBe("metadata");
    expect(resolved.requestLogging).toEqual({
      captureHeaders: true,
      logRequestBody: false,
      logResponseBody: false,
    });
  });

  it("rejects an unknown profile given in code", () => {
    expect(() =>
      resolveConfig({ captureProfile: "everything" as never }, {}),
    ).toThrow(/captureProfile: expected one of/);
  });
});

function ingestApp(config: ApiLensExpressConfig): { app: express.Express; calls: string[] } {
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  useApiLens(app, {
    apiKey: "test-api-key",
    appId: "test-app",
    compress: false,
    // beforeEach clears every APILENS_* var, including the setup.ts
    // heartbeat/metadata kill switches, so turn them off explicitly here.
    sendHeartbeat: false,
    sendMetadata: false,
    fetchImpl: async (_url, options) => {
      calls.push(String(options?.body || ""));
      return new Response(null, { status: 200 });
    },
    ...config,
  });
  app.post("/orders", (req, res) => {
    res.status(201).json({ ok: true, item: req.body.item, filler: "x".repeat(20_000) });
  });
  return { app, calls };
}

async function captureOne(config: ApiLensExpressConfig): Promise<Record<string, unknown>> {
  const { app, calls } = ingestApp(config);
  await request(app).post("/orders").set("X-Trace", "abc").send({ item: "book" }).expect(201);
  await ApiLensClient.getInstance().flushAll();
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0]).requests[0];
}

describe("captureProfile through the Express middleware", () => {
  it("metadata sends only the base record", async () => {
    const record = await captureOne({ captureProfile: "metadata" });
    expect(record.status_code).toBe(201);
    expect(record.request_headers).toBe("");
    expect(record.response_headers).toBe("");
    expect(record.request_payload).toBe("");
    expect(record.response_payload).toBe("");
  });

  it("APILENS_CAPTURE_PROFILE=metadata applies without a code change", async () => {
    process.env.APILENS_CAPTURE_PROFILE = "metadata";
    const record = await captureOne({});
    expect(record.request_headers).toBe("");
    expect(record.request_payload).toBe("");
  });

  it("redacted keeps headers and bodies, capped at 16 KB", async () => {
    const record = await captureOne({ captureProfile: "redacted" });
    expect(record.request_headers).toContain("x-trace");
    expect(record.request_payload).toContain('"item":"book"');
    const response = String(record.response_payload);
    expect(response.length).toBeGreaterThan(8192);
    expect(response.length).toBeLessThanOrEqual(16 * 1024 + 64);
  });

  it("metadata with an explicit logRequestBody keeps only the request body", async () => {
    const record = await captureOne({
      captureProfile: "metadata",
      requestLogging: { logRequestBody: true },
    });
    expect(record.request_payload).toContain('"item":"book"');
    expect(record.response_payload).toBe("");
    expect(record.request_headers).toBe("");
  });

  it("APILENS_ENABLED=false turns the middleware off", async () => {
    process.env.APILENS_ENABLED = "false";
    const { app, calls } = ingestApp({});
    await request(app).post("/orders").send({ item: "book" }).expect(201);
    await ApiLensClient.getInstance().flushAll();
    expect(calls).toHaveLength(0);
  });
});
