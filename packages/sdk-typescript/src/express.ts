import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";

import { ApiLensClient } from "./client.js";
import { RequestExcluder } from "./exclusions.js";
import { Sampler } from "./sampling.js";
import { expressRouteTemplate, parametrizeEnabled, resolveEndpointPath } from "./routes.js";
import {
  ContentTypeFilter,
  FORM_CONTENT_TYPE,
  Redactor,
  captureBody,
  lowerHeaders,
  mediaType,
  serializeHeaders,
} from "./sanitize.js";
import type { RequestBodyInfo, ResponseBodyInfo } from "./sanitize.js";
import {
  firstForwardedIp,
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

function headerString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

/**
 * The captured request body as bytes, at most `maxBytes`. Express hands the
 * body over already parsed: a parsed form (`express.urlencoded`) is
 * re-encoded as a form so it is masked field by field; other objects are
 * serialized as JSON.
 */
function requestBodyBytes(body: unknown, contentType: string, maxBytes: number): Buffer {
  if (body === undefined || body === null || maxBytes <= 0) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body.subarray(0, maxBytes);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8").subarray(0, maxBytes);
  }
  if (
    mediaType(contentType) === FORM_CONTENT_TYPE &&
    typeof body === "object" &&
    !Array.isArray(body)
  ) {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        form.append(name, typeof v === "string" ? v : JSON.stringify(v) ?? "");
      }
    }
    return Buffer.from(form.toString(), "utf8").subarray(0, maxBytes);
  }
  return Buffer.from(payloadToString(body, maxBytes), "utf8");
}

function buildClient(config: ApiLensExpressConfig = {}): ApiLensClient {
  if (config.client instanceof ApiLensClient) {
    return config.client;
  }

  return new ApiLensClient({
    apiKey: config.apiKey || config.api_key || config.clientId || config.client_id,
    projectSlug: config.projectSlug || config.project_slug,
    appId: config.appId || config.app_id,
    baseUrl: config.baseUrl || config.base_url,
    ingestPath: config.ingestPath || config.ingest_path,
    environment: config.environment || config.env,
    release: config.release,
    commit: config.commit,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    timeoutMs: config.timeoutMs,
    maxQueueSize: config.maxQueueSize,
    maxQueueBytes: config.maxQueueBytes,
    maxBatchBytes: config.maxBatchBytes,
    compress: config.compress,
    onStats: config.onStats,
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
  const captureHeaders = requestLogging.captureHeaders !== false;
  const maxPayloadBytes = Math.max(
    0,
    toNonNegativeInt(requestLogging.maxPayloadBytes, 8192),
  );
  const excluder = new RequestExcluder({
    excludePaths: config.excludePaths,
    excludeUserAgents: config.excludeUserAgents,
    defaultExclusions: config.defaultExclusions,
  });
  // Compiled once per middleware; built-in DEFAULT_MASK_* patterns always apply.
  const redactor = new Redactor({
    queryParams: config.redactQueryParams,
    headers: config.redactHeaders,
    bodyFields: config.redactBodyFields,
  });
  // Bodies of other media types (multipart, binary) are never buffered and
  // are stored as an "[<type>, N bytes omitted]" placeholder.
  const contentTypes = new ContentTypeFilter(config.captureContentTypes);
  // Validated here: an out-of-range sampleRate throws at startup.
  const sampler = new Sampler({
    sampleRate: config.sampleRate,
    sampleOnRequest: config.sampleOnRequest,
    sampleOnResponse: config.sampleOnResponse,
    logger: client.config.logger,
  });
  // Heuristic fallback for unmatched routes; APILENS_PARAMETRIZE_PATHS=false
  // overrides it. Matched Express routes are always used.
  const parametrizePaths = config.parametrizePaths !== false;

  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    if (!enabled || !client.isEnabled() || req.method.toUpperCase() === "OPTIONS") {
      next();
      return;
    }

    // Excluded requests (health checks, probes) bypass capture entirely:
    // nothing is wrapped, buffered or sent.
    if (
      excluder.shouldExclude(
        req.originalUrl || req.url,
        req.headers["user-agent"] as string | undefined,
      )
    ) {
      next();
      return;
    }

    const startedAt = performance.now();
    const method = String(req.method || "GET").toUpperCase();
    const requestSize = toNonNegativeInt(
      req.get?.("content-length") || req.headers["content-length"],
      0,
    );
    const ipAddress =
      firstForwardedIp(req.headers["x-forwarded-for"]) ||
      String(req.headers["x-real-ip"] || req.ip || req.socket?.remoteAddress || "");
    const userAgent = String(req.headers["user-agent"] || "");
    const url = String(req.originalUrl || req.url || "/");
    const queryAt = url.indexOf("?");
    const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
    // The route is matched after this middleware runs; it is read when the
    // response is sent (see res.end), while req.route / req.baseUrl still
    // describe the handler that answered.
    let routeTemplate: string | undefined;
    let routeResolved = false;
    const resolveRoute = (): void => {
      if (!routeResolved) {
        routeResolved = true;
        routeTemplate = expressRouteTemplate(
          req,
          rawPath,
          parametrizePaths && parametrizeEnabled(),
        );
      }
    };

    // Decided before any response body is buffered. Sampled-out requests are
    // still recorded (base fields only), so metrics are unaffected.
    let sampled = sampler.decideRequest(() => ({
      method,
      path: rawPath,
      query: queryAt === -1 ? "" : url.slice(queryAt + 1),
      userAgent,
      headers: req.headers,
      clientIp: ipAddress,
    }));

    const responseChunks: Buffer[] = [];
    let responseSize = 0;
    let bufferedSize = 0;
    // Decided on the first body chunk, once the handler has set Content-Type.
    let bufferResponse: boolean | undefined;
    const responseCapturable = (): boolean => {
      if (bufferResponse === undefined) {
        bufferResponse = contentTypes.allows(headerString(res.getHeader("content-type")));
      }
      return bufferResponse;
    };

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
        sampled &&
        capturePayloads &&
        logResponseBody &&
        maxPayloadBytes > 0 &&
        chunk &&
        bufferedSize < maxPayloadBytes &&
        responseCapturable()
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
      try {
        resolveRoute();
      } catch (_error) {
        // Never break the response over route resolution.
      }
      const normalizedEncoding =
        typeof encoding === "string" && Buffer.isEncoding(encoding)
          ? encoding
          : undefined;
      const byteLen = chunk
        ? Buffer.byteLength(chunk, normalizedEncoding)
        : 0;
      responseSize += byteLen;

      if (
        sampled &&
        capturePayloads &&
        logResponseBody &&
        maxPayloadBytes > 0 &&
        chunk &&
        bufferedSize < maxPayloadBytes &&
        responseCapturable()
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
        resolveRoute();
        // Endpoint grouping path: matched route template, else id-looking
        // segments parametrized. raw_path keeps the exact URL with the query
        // string, matching query-param values redacted.
        const path = resolveEndpointPath(routeTemplate, rawPath || "/", parametrizePaths);
        const query = queryAt === -1 ? "" : url.slice(queryAt + 1);
        const rawPathWithQuery = query ? `${rawPath}?${redactor.redactQuery(query)}` : rawPath;
        const consumer =
          consumerFromStringOrObject(req.apilensConsumer) ||
          consumerFromStringOrObject(config.getConsumer?.(req, res));

        sampled = sampler.decideResponse(sampled, () => ({
          method,
          route: path,
          rawPath,
          statusCode: res.statusCode,
          responseTimeMs,
          consumerId: consumer?.consumer_id || "",
          consumerName: consumer?.consumer_name || "",
          consumerGroup: consumer?.consumer_group || "",
          sampled,
        }));

        const contentLength = toNumber(res.getHeader("content-length"), 0);
        const finalResponseSize = contentLength > 0 ? contentLength : responseSize;

        // Masked here, before capture(): raw values never reach the queue.
        // The user mask callbacks run first, then the regex field masking.
        // A sampled-out request sends only the base record: no headers or bodies.
        const capturing = sampled && capturePayloads;
        const requestContentType = headerString(req.headers["content-type"]);
        let requestInfo: RequestBodyInfo | undefined;
        const getRequestInfo = (): RequestBodyInfo => {
          requestInfo ??= {
            method,
            path: rawPath,
            rawPath: rawPathWithQuery,
            headers: lowerHeaders(req.headers),
            contentType: requestContentType,
          };
          return requestInfo;
        };
        const requestPayload =
          capturing && logRequestBody
            ? captureBody(requestBodyBytes(req.body, requestContentType, maxPayloadBytes), {
                size: requestSize,
                contentType: requestContentType,
                contentTypes,
                redactor,
                masker: config.maskRequestBody,
                info: config.maskRequestBody ? getRequestInfo() : undefined,
              })
            : "";
        let responsePayload = "";
        if (capturing && logResponseBody) {
          const responseContentType = headerString(res.getHeader("content-type"));
          const responseInfo: ResponseBodyInfo | undefined = config.maskResponseBody
            ? {
                request: getRequestInfo(),
                statusCode: res.statusCode,
                headers: lowerHeaders(res.getHeaders()),
                contentType: responseContentType,
              }
            : undefined;
          responsePayload = captureBody(Buffer.concat(responseChunks), {
            size: Math.max(finalResponseSize, 0),
            contentType: responseContentType,
            contentTypes,
            redactor,
            masker: config.maskResponseBody,
            info: responseInfo,
          });
        }

        client.capture({
          timestamp: new Date(),
          environment,
          project_slug: client.config.projectSlug,
          app_id: client.config.appId,
          method,
          path,
          raw_path: rawPathWithQuery,
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
          request_headers:
            sampled && captureHeaders ? serializeHeaders(req.headers, { redactor }) : "",
          response_headers:
            sampled && captureHeaders ? serializeHeaders(res.getHeaders(), { redactor }) : "",
          sampled,
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
