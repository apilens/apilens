import { afterEach, describe, expect, it } from "vitest";

import { ApiLensClient } from "../src/client.js";
import {
  createApiLensNextConfig,
  getApiLensNextEnvSummary,
  setConsumer,
  withApiLens,
} from "../src/next.js";

const ORIGINAL_ENV = {
  APILENS_API_KEY: process.env.APILENS_API_KEY,
  APILENS_BASE_URL: process.env.APILENS_BASE_URL,
  APILENS_ENVIRONMENT: process.env.APILENS_ENVIRONMENT,
};

async function waitForCapturePipeline(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (typeof value === "string") {
      process.env[key] = value;
      continue;
    }
    delete process.env[key];
  }
}

afterEach(async () => {
  await ApiLensClient.shutdown();
  restoreEnv();
});

describe("Next.js route handler wrapper", () => {
  it("builds Next.js config from APILENS_* env vars", () => {
    process.env.APILENS_API_KEY = "env-api-key";
    process.env.APILENS_BASE_URL = "http://localhost:8000/api/v1";
    process.env.APILENS_ENVIRONMENT = "local";

    const config = createApiLensNextConfig();
    const summary = getApiLensNextEnvSummary();

    expect(config.apiKey).toBe("env-api-key");
    expect(config.baseUrl).toBe("http://localhost:8000/api/v1");
    expect(config.environment).toBe("local");
    expect(config.enabled).toBe(true);

    expect(summary.hasApiKey).toBe(true);
    expect(summary.baseUrl).toBe("http://localhost:8000/api/v1");
    expect(summary.environment).toBe("local");
  });

  it("prefers explicit config over APILENS_* env vars", () => {
    process.env.APILENS_API_KEY = "env-api-key";
    process.env.APILENS_BASE_URL = "http://localhost:8000/api/v1";
    process.env.APILENS_ENVIRONMENT = "local";

    const config = createApiLensNextConfig({
      apiKey: "override-key",
      baseUrl: "http://localhost:9000/custom",
      environment: "staging",
      enabled: true,
    });
    const summary = getApiLensNextEnvSummary({
      apiKey: "override-key",
      baseUrl: "http://localhost:9000/custom",
      environment: "staging",
    });

    expect(config.apiKey).toBe("override-key");
    expect(config.baseUrl).toBe("http://localhost:9000/custom");
    expect(config.environment).toBe("staging");
    expect(config.enabled).toBe(true);
    expect(summary.hasApiKey).toBe(true);
  });

  it("auto-disables when no API key is available", async () => {
    delete process.env.APILENS_API_KEY;
    process.env.APILENS_BASE_URL = "http://localhost:8000/api/v1";
    process.env.APILENS_ENVIRONMENT = "local";

    const config = createApiLensNextConfig();
    const summary = getApiLensNextEnvSummary();
    const route = withApiLens(async () => Response.json({ ok: true }));

    const response = await route(new Request("http://localhost/ping"));
    expect(response.status).toBe(200);

    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBe("missing-api-key");
    expect(summary.hasApiKey).toBe(false);
  });

  it("uses getConsumer callback when setConsumer is not called", async () => {
    const ingestCalls: string[] = [];
    const route = withApiLens(async () => {
      return Response.json({ ok: true }, { status: 200 });
    }, {
      apiKey: "test-api-key",
      batchSize: 100,
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
      getConsumer: (request) => {
        const id = request.headers.get("x-consumer-id");
        if (!id) {
          return null;
        }
        return { id, name: "Header User", group: "header" };
      },
    });

    const response = await route(new Request("http://localhost/get-consumer", {
      headers: { "x-consumer-id": "c_42" },
    }));
    expect(response.status).toBe(200);

    await waitForCapturePipeline();
    await ApiLensClient.getInstance().flushAll();

    const payload = JSON.parse(ingestCalls[0]);
    const record = payload.requests[0];
    expect(record.consumer_id).toBe("c_42");
    expect(record.consumer_name).toBe("Header User");
    expect(record.consumer_group).toBe("header");
  });

  it("respects payload capture flags and maxPayloadBytes", async () => {
    const ingestCalls: string[] = [];
    const route = withApiLens(async () => {
      return new Response("response-abcdefghijklmnopqrstuvwxyz", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }, {
      apiKey: "test-api-key",
      batchSize: 100,
      requestLogging: {
        logRequestBody: true,
        logResponseBody: true,
        maxPayloadBytes: 10,
      },
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });

    const response = await route(new Request("http://localhost/truncate", {
      method: "POST",
      body: "request-abcdefghijklmnopqrstuvwxyz",
    }));
    expect(response.status).toBe(200);

    await waitForCapturePipeline();
    await ApiLensClient.getInstance().flushAll();

    const payload = JSON.parse(ingestCalls[0]);
    const record = payload.requests[0];
    expect(Buffer.from(record.request_payload, "utf8").length).toBeLessThanOrEqual(10);
    expect(Buffer.from(record.response_payload, "utf8").length).toBeLessThanOrEqual(10);
  });

  it("captures request/response metadata and consumer details", async () => {
    const ingestCalls: string[] = [];
    const postOrders = withApiLens(async (request: Request) => {
      setConsumer(request, { id: "user_123", name: "John", group: "starter" });
      const body = (await request.json()) as { item: string };
      return Response.json({ ok: true, item: body.item }, { status: 201 });
    }, {
      apiKey: "test-api-key",
      environment: "test",
      batchSize: 100,
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });

    const request = new Request("http://localhost/orders?expand=true", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "next-sdk-test",
        "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
      },
      body: JSON.stringify({ item: "book" }),
    });

    const response = await postOrders(request);
    expect(response.status).toBe(201);

    await waitForCapturePipeline();
    await ApiLensClient.getInstance().flushAll();

    expect(ingestCalls).toHaveLength(1);
    const payload = JSON.parse(ingestCalls[0]);
    expect(payload.requests).toHaveLength(1);

    const record = payload.requests[0];
    expect(record.environment).toBe("test");
    expect(record.method).toBe("POST");
    expect(record.path).toBe("/orders");
    expect(record.status_code).toBe(201);
    expect(record.ip_address).toBe("1.2.3.4");
    expect(record.user_agent).toBe("next-sdk-test");
    expect(record.consumer_id).toBe("user_123");
    expect(record.consumer_name).toBe("John");
    expect(record.consumer_group).toBe("starter");
    expect(record.request_payload).toContain('"item":"book"');
    expect(record.response_payload).toContain('"ok":true');
    expect(record.response_time_ms).toBeGreaterThanOrEqual(0);
  });

  it("captures thrown handler errors as 500 responses", async () => {
    const ingestCalls: string[] = [];
    const crashingRoute = withApiLens(async () => {
      throw new Error("boom");
    }, {
      apiKey: "test-api-key",
      batchSize: 100,
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });

    await expect(
      crashingRoute(
        new Request("http://localhost/fail", {
          method: "POST",
          body: JSON.stringify({ reason: "test" }),
        }),
      ),
    ).rejects.toThrow("boom");

    await waitForCapturePipeline();
    await ApiLensClient.getInstance().flushAll();

    expect(ingestCalls).toHaveLength(1);
    const payload = JSON.parse(ingestCalls[0]);
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0].path).toBe("/fail");
    expect(payload.requests[0].status_code).toBe(500);
  });

  it("skips capture for OPTIONS requests", async () => {
    const ingestCalls: string[] = [];
    const optionsRoute = withApiLens(async () => {
      return new Response(null, { status: 204 });
    }, {
      apiKey: "test-api-key",
      batchSize: 100,
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });

    const response = await optionsRoute(
      new Request("http://localhost/health", { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);

    await waitForCapturePipeline();
    await ApiLensClient.getInstance().flushAll();

    expect(ingestCalls).toHaveLength(0);
  });
});
