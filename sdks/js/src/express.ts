import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";

import { ApiLensClient } from "./client.js";
import {
  firstForwardedIp,
  normalizePath,
  payloadToString,
  toNonNegativeInt,
  toNumber,
} from "./utils.js";
import type { ApiLensConsumer, ApiLensExpressConfig } from "./types.js";

declare module "express-serve-static-core" {
  interface Request {
    apilensConsumer?: ApiLensConsumer | string;
  }

  interface Application {
    apilensClient?: ApiLensClient;
  }
}

type MiddlewareWithClient = ((req: Request, res: Response, next: NextFunction) => void) & {
  apilensClient: ApiLensClient;
};

function consumerFromStringOrObject(
  value: ApiLensConsumer | string | null | undefined,
): { consumer_id: string; consumer_name: string; consumer_group: string } | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return {
      consumer_id: value,
      consumer_name: "",
      consumer_group: "",
    };
  }

  return {
    consumer_id: String(value.id || value.identifier || value.consumer_id || ""),
    consumer_name: String(value.name || value.consumer_name || ""),
    consumer_group: String(value.group || value.consumer_group || ""),
  };
}

function setConsumer(
  req: Request,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  req.apilensConsumer = consumer || undefined;
}

function trackConsumer(
  req: Request,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  setConsumer(req, consumer);
}

function buildClient(config: ApiLensExpressConfig = {}): ApiLensClient {
  if (config.client instanceof ApiLensClient) {
    return config.client;
  }

  return new ApiLensClient({
    apiKey: config.apiKey || config.api_key || config.clientId || config.client_id,
    baseUrl: config.baseUrl || config.base_url,
    ingestPath: config.ingestPath || config.ingest_path,
    environment: config.environment || config.env,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    timeoutMs: config.timeoutMs,
    maxQueueSize: config.maxQueueSize,
    maxRetries: config.maxRetries,
    retryBackoffBaseMs: config.retryBackoffBaseMs,
    retryBackoffMaxMs: config.retryBackoffMaxMs,
    enabled: config.enabled,
    userAgent: config.userAgent,
    fetchImpl: config.fetchImpl,
    logger: config.logger,
  });
}

function createApiLensMiddleware(config: ApiLensExpressConfig = {}): MiddlewareWithClient {
  const client = buildClient(config);
  const environment = config.environment || config.env;
  const requestLogging = config.requestLogging || {};

  const enabled = config.enabled !== false;
  const logRequestBody = requestLogging.logRequestBody !== false;
  const logResponseBody = requestLogging.logResponseBody !== false;
  const capturePayloads = requestLogging.capturePayloads !== false;
  const maxPayloadBytes = Math.max(
    0,
    toNonNegativeInt(requestLogging.maxPayloadBytes, 8192),
  );

  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    if (!enabled || !client.isEnabled() || req.method.toUpperCase() === "OPTIONS") {
      next();
      return;
    }

    const startedAt = performance.now();
    const method = String(req.method || "GET").toUpperCase();
    const path = normalizePath(req.route?.path || req.path || req.originalUrl || "/");
    const requestSize = toNonNegativeInt(
      req.get?.("content-length") || req.headers["content-length"],
      0,
    );
    const ipAddress =
      firstForwardedIp(req.headers["x-forwarded-for"]) ||
      String(req.headers["x-real-ip"] || req.ip || req.socket?.remoteAddress || "");
    const userAgent = String(req.headers["user-agent"] || "");

    const responseChunks: Buffer[] = [];
    let responseSize = 0;
    let bufferedSize = 0;

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = ((chunk: any, encoding?: any, cb?: any) => {
      const normalizedEncoding =
        typeof encoding === "string" && Buffer.isEncoding(encoding)
          ? encoding
          : undefined;
      const byteLen = chunk
        ? Buffer.byteLength(chunk, normalizedEncoding)
        : 0;
      responseSize += byteLen;

      if (
        capturePayloads &&
        logResponseBody &&
        maxPayloadBytes > 0 &&
        chunk &&
        bufferedSize < maxPayloadBytes
      ) {
        const raw = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, normalizedEncoding);
        const room = maxPayloadBytes - bufferedSize;
        const part = raw.subarray(0, room);
        responseChunks.push(part);
        bufferedSize += part.length;
      }

      return originalWrite(chunk, encoding, cb);
    }) as typeof res.write;

    res.end = ((chunk: any, encoding?: any, cb?: any) => {
      const normalizedEncoding =
        typeof encoding === "string" && Buffer.isEncoding(encoding)
          ? encoding
          : undefined;
      const byteLen = chunk
        ? Buffer.byteLength(chunk, normalizedEncoding)
        : 0;
      responseSize += byteLen;

      if (
        capturePayloads &&
        logResponseBody &&
        maxPayloadBytes > 0 &&
        chunk &&
        bufferedSize < maxPayloadBytes
      ) {
        const raw = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, normalizedEncoding);
        const room = maxPayloadBytes - bufferedSize;
        const part = raw.subarray(0, room);
        responseChunks.push(part);
        bufferedSize += part.length;
      }

      return originalEnd(chunk, encoding, cb);
    }) as typeof res.end;

    res.once("finish", () => {
      try {
        const responseTimeMs = Math.max(performance.now() - startedAt, 0);
        const consumer =
          consumerFromStringOrObject(req.apilensConsumer) ||
          consumerFromStringOrObject(config.getConsumer?.(req, res));

        const requestPayload =
          capturePayloads && logRequestBody
            ? payloadToString(req.body, maxPayloadBytes)
            : "";
        const responsePayload =
          capturePayloads && logResponseBody
            ? Buffer.concat(responseChunks).toString("utf8")
            : "";

        const contentLength = toNumber(res.getHeader("content-length"), 0);
        const finalResponseSize = contentLength > 0 ? contentLength : responseSize;

        client.capture({
          timestamp: new Date(),
          environment,
          method,
          path,
          status_code: res.statusCode,
          response_time_ms: responseTimeMs,
          request_size: requestSize,
          response_size: Math.max(finalResponseSize, 0),
          ip_address: ipAddress,
          user_agent: userAgent,
          consumer_id: consumer?.consumer_id || "",
          consumer_name: consumer?.consumer_name || "",
          consumer_group: consumer?.consumer_group || "",
          request_payload: requestPayload,
          response_payload: responsePayload,
        });
      } catch (error) {
        client.config.logger.error?.(
          "Error while logging request in API Lens middleware",
          error,
        );
      }
    });

    next();
  }) as MiddlewareWithClient;

  middleware.apilensClient = client;
  return middleware;
}

function useApiLens(app: { use: (mw: MiddlewareWithClient) => void; apilensClient?: ApiLensClient }, config: ApiLensExpressConfig = {}): MiddlewareWithClient {
  const middleware = createApiLensMiddleware(config);
  app.use(middleware);
  app.apilensClient = middleware.apilensClient;
  return middleware;
}

const createExpressMiddleware = createApiLensMiddleware;
const instrumentExpress = useApiLens;

export {
  createApiLensMiddleware,
  createExpressMiddleware,
  instrumentExpress,
  setConsumer,
  trackConsumer,
  useApiLens,
};
