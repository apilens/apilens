import { createServer } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { setConsumer, useApiLens } from "../src/express.js";

afterEach(async () => {
  await ApiLensClient.shutdown();
});

let canListen = true;

async function detectListenSupport(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

describe("Express E2E", () => {
  beforeAll(async () => {
    canListen = await detectListenSupport();
  });

  it("captures request, response, and consumer metadata", async () => {
    if (!canListen) {
      return;
    }

    const ingestCalls: string[] = [];
    const app = express();
    app.use(express.json());

    useApiLens(app, {
      apiKey: "test-api-key",
      environment: "test",
      batchSize: 100,
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });

    app.post("/orders", (req, res) => {
      setConsumer(req, { id: "user_123", name: "John", group: "starter" });
      res.status(201).json({ ok: true, item: req.body.item });
    });

    await request(app)
      .post("/orders")
      .set("User-Agent", "sdk-test")
      .set("X-Forwarded-For", "1.2.3.4")
      .send({ item: "book" })
      .expect(201);

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
    expect(record.user_agent).toBe("sdk-test");
    expect(record.consumer_id).toBe("user_123");
    expect(record.consumer_name).toBe("John");
    expect(record.consumer_group).toBe("starter");
    expect(record.request_payload).toContain('"item":"book"');
    expect(record.response_payload).toContain('"ok":true');
    expect(record.response_time_ms).toBeGreaterThanOrEqual(0);
  });

  it("skips capture for OPTIONS requests", async () => {
    if (!canListen) {
      return;
    }

    const ingestCalls: string[] = [];
    const app = express();

    useApiLens(app, {
      apiKey: "test-api-key",
      batchSize: 100,
      fetchImpl: async (_url, options) => {
        ingestCalls.push(String(options?.body || ""));
        return new Response(null, { status: 200 });
      },
    });

    app.options("/health", (_req, res) => {
      res.status(204).end();
    });

    await request(app).options("/health").expect(204);
    await ApiLensClient.getInstance().flushAll();

    expect(ingestCalls).toHaveLength(0);
  });
});
