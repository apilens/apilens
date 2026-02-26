import { afterEach, describe, expect, it } from "vitest";

import { ApiLensClient } from "../src/client.js";

afterEach(async () => {
  await ApiLensClient.shutdown();
});

describe("ApiLensClient", () => {
  it("throws when apiKey is missing", () => {
    expect(() => {
      new ApiLensClient({
        fetchImpl: async () => new Response(null, { status: 200 }),
      });
    }).toThrow("apiKey is required");
  });

  it("normalizes records and fills defaults", async () => {
    const calls: Array<{ body?: string }> = [];
    const client = new ApiLensClient({
      apiKey: "test",
      enabled: true,
      batchSize: 10,
      fetchImpl: async (_url, options) => {
        calls.push({ body: String(options?.body || "") });
        return new Response(null, { status: 200 });
      },
    });

    client.stop();
    client.capture({
      method: "post",
      path: "v1/orders",
      status_code: 201,
      response_time_ms: 15.2,
    });

    await client.flushAll();

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].body || "{}");
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0].method).toBe("POST");
    expect(payload.requests[0].path).toBe("/v1/orders");
    expect(payload.requests[0].environment).toBe("production");
  });

  it("drops oldest records when queue is full", () => {
    const client = new ApiLensClient({
      apiKey: "test",
      enabled: true,
      batchSize: 10,
      maxQueueSize: 2,
      fetchImpl: async () => new Response(null, { status: 200 }),
    });

    client.stop();
    client.capture({ method: "GET", path: "/a", status_code: 200, response_time_ms: 1 });
    client.capture({ method: "GET", path: "/b", status_code: 200, response_time_ms: 1 });
    client.capture({ method: "GET", path: "/c", status_code: 200, response_time_ms: 1 });

    expect(client.droppedCount).toBe(1);
    expect(client.queue).toHaveLength(2);
    expect(client.queue[0].path).toBe("/b");
    expect(client.queue[1].path).toBe("/c");
  });

  it("retries failed ingests", async () => {
    let attempts = 0;

    const client = new ApiLensClient({
      apiKey: "test",
      enabled: true,
      batchSize: 10,
      maxRetries: 2,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 5,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 200 });
      },
    });

    client.stop();
    client.capture({ method: "GET", path: "/retry", status_code: 200, response_time_ms: 1 });

    const sent = await client.flushAll();
    expect(sent).toBe(1);
    expect(attempts).toBe(3);
  });

  it("resolves relative ingest path against baseUrl path", async () => {
    const urls: string[] = [];
    const client = new ApiLensClient({
      apiKey: "test",
      baseUrl: "http://localhost:8000/api/v1",
      ingestPath: "ingest/requests",
      enabled: true,
      batchSize: 10,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(null, { status: 200 });
      },
    });

    client.stop();
    client.capture({ method: "GET", path: "/x", status_code: 200, response_time_ms: 1 });
    await client.flushAll();
    expect(urls[0]).toBe("http://localhost:8000/api/v1/ingest/requests");
  });

  it("keeps leading slash ingest path at host root", async () => {
    const urls: string[] = [];
    const client = new ApiLensClient({
      apiKey: "test",
      baseUrl: "http://localhost:8000/api/v1",
      ingestPath: "/ingest/requests",
      enabled: true,
      batchSize: 10,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(null, { status: 200 });
      },
    });

    client.stop();
    client.capture({ method: "GET", path: "/x", status_code: 200, response_time_ms: 1 });
    await client.flushAll();
    expect(urls[0]).toBe("http://localhost:8000/ingest/requests");
  });

  it("uses absolute ingestPath as-is", async () => {
    const urls: string[] = [];
    const client = new ApiLensClient({
      apiKey: "test",
      baseUrl: "http://localhost:8000/api/v1",
      ingestPath: "https://ingest.example.com/v2/requests",
      enabled: true,
      batchSize: 10,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(null, { status: 200 });
      },
    });

    client.stop();
    client.capture({ method: "GET", path: "/x", status_code: 200, response_time_ms: 1 });
    await client.flushAll();
    expect(urls[0]).toBe("https://ingest.example.com/v2/requests");
  });

  it("does not queue or send records when disabled", async () => {
    let calls = 0;
    const client = new ApiLensClient({
      apiKey: "disabled-key",
      enabled: false,
      batchSize: 1,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    });

    client.capture({
      method: "POST",
      path: "/disabled",
      status_code: 201,
      response_time_ms: 1,
    });
    const flushed = await client.flushAll();

    expect(client.queue).toHaveLength(0);
    expect(flushed).toBe(0);
    expect(calls).toBe(0);
  });

  it("drops failed batch after retry exhaustion", async () => {
    let calls = 0;
    const client = new ApiLensClient({
      apiKey: "test",
      enabled: true,
      batchSize: 10,
      maxRetries: 1,
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 1,
      logger: {
        warn: () => undefined,
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 503 });
      },
    });

    client.stop();
    client.capture({ method: "GET", path: "/fail", status_code: 200, response_time_ms: 1 });

    const sent = await client.flushAll();
    expect(sent).toBe(0);
    expect(calls).toBe(2);
    expect(client.queue).toHaveLength(0);
  });
});
