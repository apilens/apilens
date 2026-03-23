import { performance } from "node:perf_hooks";

import { ApiLensClient } from "./client.js";
import {
  firstForwardedIp,
  normalizePath,
  payloadToString,
  toNonNegativeInt,
  toNumber,
} from "./utils.js";
import type {
  ApiLensConsumer,
  ApiLensNextConfig,
  ApiLensNextEnvSummary,
} from "./types.js";

type ConsumerSnapshot = {
  consumer_id: string;
  consumer_name: string;
  consumer_group: string;
};

type PayloadSnapshot = {
  payload: string;
  size: number;
};

type NextRouteHandler<TContext = unknown, TRequest extends Request = Request> = (
  request: TRequest,
  context?: TContext,
) => Response | Promise<Response>;

type NextRouteHandlerWithClient<
  TContext = unknown,
  TRequest extends Request = Request,
> = NextRouteHandler<TContext, TRequest> & { apilensClient: ApiLensClient };

const consumerByRequest = new WeakMap<Request, ApiLensConsumer | string>();
const DEFAULT_BASE_URL = "https://api.apilens.ai/api/v1";
const DEFAULT_ENVIRONMENT = "production";
const DISABLED_PLACEHOLDER_API_KEY = "missing-api-key";

function readProcessEnv(key: string): string {
  if (typeof process === "undefined" || !process.env) {
    return "";
  }

  return String(process.env[key] || "").trim();
}

function consumerFromStringOrObject(
  value: ApiLensConsumer | string | null | undefined,
): ConsumerSnapshot | null {
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
  request: Request,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  if (!consumer) {
    consumerByRequest.delete(request);
    return;
  }

  consumerByRequest.set(request, consumer);
}

function trackConsumer(
  request: Request,
  consumer: ApiLensConsumer | string | null | undefined,
): void {
  setConsumer(request, consumer);
}

function createApiLensNextConfig(config: ApiLensNextConfig = {}): ApiLensNextConfig {
  const apiKey =
    String(
      config.apiKey || config.api_key || config.clientId || config.client_id || "",
    ).trim() || readProcessEnv("APILENS_API_KEY");
  const baseUrl =
    String(config.baseUrl || config.base_url || "").trim() ||
    readProcessEnv("APILENS_BASE_URL") ||
    DEFAULT_BASE_URL;
  const environment =
    String(config.environment || config.env || "").trim() ||
    readProcessEnv("APILENS_ENVIRONMENT") ||
    DEFAULT_ENVIRONMENT;
  const enabled = config.enabled ?? Boolean(apiKey);
  const normalizedApiKey =
    apiKey || (enabled ? "" : DISABLED_PLACEHOLDER_API_KEY);

  return {
    ...config,
    apiKey: normalizedApiKey,
    baseUrl,
    environment,
    enabled,
  };
}

function getApiLensNextEnvSummary(
  config: ApiLensNextConfig = {},
): ApiLensNextEnvSummary {
  const normalized = createApiLensNextConfig(config);
  const apiKey = String(normalized.apiKey || "").trim();
  return {
    hasApiKey: Boolean(apiKey) && apiKey !== DISABLED_PLACEHOLDER_API_KEY,
    baseUrl: String(normalized.baseUrl || DEFAULT_BASE_URL),
    environment: String(normalized.environment || DEFAULT_ENVIRONMENT),
  };
}

function buildClient(config: ApiLensNextConfig): ApiLensClient {
  if (config.client instanceof ApiLensClient) {
    return config.client;
  }

  try {
    return ApiLensClient.getInstance();
  } catch (_error) {
    // No existing singleton; create one with Next.js-friendly defaults.
  }

  return new ApiLensClient({
    apiKey:
      config.apiKey || config.api_key || config.clientId || config.client_id,
    baseUrl: config.baseUrl || config.base_url,
    ingestPath: config.ingestPath || config.ingest_path,
    environment: config.environment || config.env,
    batchSize: config.batchSize ?? 1,
    flushIntervalMs: config.flushIntervalMs ?? 1000,
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

function requestPathFromUrl(url: string): string {
  try {
    return normalizePath(new URL(url).pathname || "/");
  } catch (_error) {
    return "/";
  }
}

async function readRequestPayload(
  request: Request,
  maxPayloadBytes: number,
  capturePayload: boolean,
): Promise<PayloadSnapshot> {
  const declaredSize = toNonNegativeInt(request.headers.get("content-length"), 0);
  const method = String(request.method || "GET").toUpperCase();
  const hasRequestBody = method !== "GET" && method !== "HEAD";

  if (!hasRequestBody) {
    return {
      payload: "",
      size: declaredSize,
    };
  }

  if (!capturePayload && declaredSize > 0) {
    return {
      payload: "",
      size: declaredSize,
    };
  }

  try {
    const bodyBytes = Buffer.from(await request.clone().arrayBuffer());
    return {
      payload: capturePayload ? payloadToString(bodyBytes, maxPayloadBytes) : "",
      size: bodyBytes.length || declaredSize,
    };
  } catch (_error) {
    return {
      payload: "",
      size: declaredSize,
    };
  }
}

async function readResponsePayload(
  response: Response,
  maxPayloadBytes: number,
  capturePayload: boolean,
): Promise<PayloadSnapshot> {
  const declaredSize = toNonNegativeInt(response.headers.get("content-length"), 0);

  if (!capturePayload && declaredSize > 0) {
    return {
      payload: "",
      size: declaredSize,
    };
  }

  try {
    const bodyBytes = Buffer.from(await response.clone().arrayBuffer());
    return {
      payload: capturePayload ? payloadToString(bodyBytes, maxPayloadBytes) : "",
      size: bodyBytes.length || declaredSize,
    };
  } catch (_error) {
    return {
      payload: "",
      size: declaredSize,
    };
  }
}

function withApiLens<TContext = unknown, TRequest extends Request = Request>(
  handler: NextRouteHandler<TContext, TRequest>,
  config: ApiLensNextConfig = {},
): NextRouteHandlerWithClient<TContext, TRequest> {
  const normalized = createApiLensNextConfig(config);
  const client = buildClient(normalized);
  const environment = normalized.environment || normalized.env;
  const requestLogging = normalized.requestLogging || {};

  const enabled = normalized.enabled !== false;
  const logRequestBody = requestLogging.logRequestBody !== false;
  const logResponseBody = requestLogging.logResponseBody !== false;
  const capturePayloads = requestLogging.capturePayloads !== false;
  const maxPayloadBytes = Math.max(
    0,
    toNonNegativeInt(requestLogging.maxPayloadBytes, 8192),
  );

  const wrapped = (async (request: TRequest, context?: TContext) => {
    const method = String(request.method || "GET").toUpperCase();

    if (!enabled || !client.isEnabled() || method === "OPTIONS") {
      return handler(request, context);
    }

    const startedAt = performance.now();
    const path = requestPathFromUrl(request.url);
    const ipAddress =
      firstForwardedIp(request.headers.get("x-forwarded-for")) ||
      String(request.headers.get("x-real-ip") || "");
    const userAgent = String(request.headers.get("user-agent") || "");
    const requestPayloadPromise = readRequestPayload(
      request,
      maxPayloadBytes,
      capturePayloads && logRequestBody,
    );

    const captureFinalRecord = async (response?: Response, statusCode = 500) => {
      try {
        const responseTimeMs = Math.max(performance.now() - startedAt, 0);
        const [requestSnapshot, responseSnapshot] = await Promise.all([
          requestPayloadPromise,
          response
            ? readResponsePayload(
                response,
                maxPayloadBytes,
                capturePayloads && logResponseBody,
              )
            : Promise.resolve({ payload: "", size: 0 }),
        ]);

        const consumer =
          consumerFromStringOrObject(consumerByRequest.get(request)) ||
          consumerFromStringOrObject(
            normalized.getConsumer?.(request, response, context),
          );

        client.capture({
          timestamp: new Date(),
          environment,
          method,
          path,
          status_code: statusCode,
          response_time_ms: responseTimeMs,
          request_size: requestSnapshot.size,
          response_size: responseSnapshot.size,
          ip_address: ipAddress,
          user_agent: userAgent,
          consumer_id: consumer?.consumer_id || "",
          consumer_name: consumer?.consumer_name || "",
          consumer_group: consumer?.consumer_group || "",
          request_payload: requestSnapshot.payload,
          response_payload: responseSnapshot.payload,
        });
      } catch (error) {
        client.config.logger.error?.(
          "Error while logging request in API Lens Next.js route handler",
          error,
        );
      } finally {
        consumerByRequest.delete(request);
      }
    };

    try {
      const response = await handler(request, context);
      const finalStatusCode =
        response instanceof Response
          ? Math.max(toNumber(response.status, 200), 100)
          : 200;
      const finalResponse =
        response instanceof Response ? response : new Response(response);

      void captureFinalRecord(finalResponse, finalStatusCode);
      return finalResponse;
    } catch (error) {
      void captureFinalRecord(undefined, 500);
      throw error;
    }
  }) as NextRouteHandlerWithClient<TContext, TRequest>;

  wrapped.apilensClient = client;
  return wrapped;
}

const createApiLensRouteHandler = withApiLens;
const createNextRouteHandler = withApiLens;
const instrumentNextRouteHandler = withApiLens;

export {
  createApiLensNextConfig,
  getApiLensNextEnvSummary,
  createApiLensRouteHandler,
  createNextRouteHandler,
  instrumentNextRouteHandler,
  setConsumer,
  trackConsumer,
  withApiLens,
};
export type { NextRouteHandler, NextRouteHandlerWithClient };
