import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeAppChoice, resolveAppId } from "../src/app.js";
import { ApiLensClient } from "../src/client.js";
import type { ApiLensClientConfig } from "../src/types.js";

const VARS = ["APILENS_APP_ID", "OTEL_SERVICE_NAME", "APILENS_SEND_HEARTBEAT", "APILENS_SEND_METADATA"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of VARS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
  await ApiLensClient.shutdown();
});

type Sent = { url: string; body: Record<string, unknown> };

function makeClient(overrides: ApiLensClientConfig = {}) {
  const infos: string[] = [];
  const sent: Sent[] = [];
  const client = new ApiLensClient({
    apiKey: "k",
    enabled: true,
    compress: false,
    sendMetadata: false,
    sendHeartbeat: false,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    logger: { debug() {}, info: (msg: unknown) => infos.push(String(msg)), warn() {}, error() {} },
    ...overrides,
  });
  client.stop();
  return { client, infos, sent };
}

describe("resolveAppId", () => {
  it("prefers code, then APILENS_APP_ID, then OTEL_SERVICE_NAME", () => {
    const env = { APILENS_APP_ID: "env-app", OTEL_SERVICE_NAME: "otel" };
    expect(resolveAppId("code-app", env)).toEqual({ appId: "code-app", source: "appId" });
    expect(resolveAppId("", env)).toEqual({ appId: "env-app", source: "APILENS_APP_ID" });
    expect(resolveAppId(undefined, { APILENS_APP_ID: " ", OTEL_SERVICE_NAME: "Orders API" })).toEqual({
      appId: "Orders API",
      source: "OTEL_SERVICE_NAME",
    });
    expect(resolveAppId(undefined, {})).toEqual({ appId: "", source: "" });
  });

  it("formats the startup line", () => {
    expect(describeAppChoice("orders-api", "APILENS_APP_ID")).toBe('APILens: app "orders-api" (from APILENS_APP_ID)');
    expect(describeAppChoice("", "")).toBe(
      "APILens: no app name configured; data goes to the project's default app (set app_id, APILENS_APP_ID or OTEL_SERVICE_NAME)",
    );
  });
});

describe("ApiLensClient app id", () => {
  it("explicit appId wins over both env vars, free-form names allowed", () => {
    process.env.APILENS_APP_ID = "env-app";
    process.env.OTEL_SERVICE_NAME = "otel";
    const { client, infos } = makeClient({ appId: "Orders API" });
    expect(client.config.appId).toBe("Orders API");
    expect(infos).toContain('APILens: app "Orders API" (from appId)');
  });

  it("falls back to APILENS_APP_ID, then OTEL_SERVICE_NAME", async () => {
    process.env.APILENS_APP_ID = "env-app";
    process.env.OTEL_SERVICE_NAME = "otel";
    const first = makeClient();
    expect(first.client.config.appId).toBe("env-app");
    expect(first.infos).toContain('APILens: app "env-app" (from APILENS_APP_ID)');
    await ApiLensClient.shutdown();

    delete process.env.APILENS_APP_ID;
    const second = makeClient();
    expect(second.client.config.appId).toBe("otel");
    expect(second.infos).toContain('APILens: app "otel" (from OTEL_SERVICE_NAME)');
  });

  it("omitted: no throw, empty app_id on every signal (default app)", async () => {
    // tests/setup.ts turns both off process-wide; restored by afterEach.
    process.env.APILENS_SEND_HEARTBEAT = "true";
    process.env.APILENS_SEND_METADATA = "true";
    const { client, infos, sent } = makeClient({ sendHeartbeat: true, sendMetadata: true });
    expect(client.config.appId).toBe("");
    expect(infos).toContain(describeAppChoice("", ""));
    client.capture({ method: "GET", path: "/orders", status_code: 200, response_time_ms: 1 });
    await client.flushAll();
    const requests = sent.filter((s) => s.url.endsWith("/requests"));
    expect(requests).toHaveLength(1);
    const records = requests[0].body.requests as Array<Record<string, unknown>>;
    expect(records[0].app_id).toBe("");
    expect(await client.sendHeartbeat()).toBe(true);
    const heartbeat = sent.find((s) => s.url.endsWith("/heartbeat"));
    expect(heartbeat?.body.app_id).toBe("");
    expect(client.reportMetadata(() => ({ app_id: "", routes: [] }), { delayMs: 0 })).toBe(true);
  });
});
