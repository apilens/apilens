/**
 * Single `APILENS_*` environment-variable config loader, mirroring the Python
 * SDK's `apilens.client._env` (same variable names, same value syntax).
 *
 * Every capture, masking, sampling and exclusion option can be set from the
 * environment, so a kill switch or a new redaction pattern never needs a code
 * change. Precedence everywhere: explicit option > env var > default.
 *
 * Value syntax:
 * - booleans accept `1`/`0`/`true`/`false` (also `yes`/`no`/`on`/`off`),
 *   case-insensitive;
 * - lists are comma-separated (blank entries dropped), so a regex that needs
 *   a literal comma (`{1,3}`) must be passed as an array in code;
 * - an unset or empty variable is ignored; an unparseable value throws an
 *   `Error` naming the variable, when the client / middleware is created.
 *
 * `APILENS_EXCLUDE_PATHS` / `APILENS_EXCLUDE_USER_AGENTS` add to the patterns
 * passed in code instead of being a fallback.
 */

import { splitPatterns } from "./exclusions.js";
import type {
  ApiLensExpressConfig,
  CaptureProfile,
  RequestLoggingConfig,
} from "./types.js";

export type Env = Record<string, string | undefined>;

export const ENV_PREFIX = "APILENS_";

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

export const CAPTURE_PROFILE_NAMES: readonly CaptureProfile[] = Object.freeze([
  "metadata",
  "redacted",
  "full",
]);

/** Body cap applied by the `redacted` profile (16 KB). */
export const REDACTED_PROFILE_MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * Preset → the `requestLogging` flags it sets. A preset only fills flags the
 * caller (code or env) left unset.
 */
export const CAPTURE_PROFILES: Readonly<Record<CaptureProfile, Readonly<RequestLoggingConfig>>> =
  Object.freeze({
    metadata: Object.freeze({
      captureHeaders: false,
      logRequestBody: false,
      logResponseBody: false,
    }),
    redacted: Object.freeze({
      captureHeaders: true,
      capturePayloads: true,
      logRequestBody: true,
      logResponseBody: true,
      maxPayloadBytes: REDACTED_PROFILE_MAX_PAYLOAD_BYTES,
    }),
    full: Object.freeze({}),
  });

export function parseBool(value: string, name = "value"): boolean {
  const raw = value.trim().toLowerCase();
  if (TRUE.has(raw)) {
    return true;
  }
  if (FALSE.has(raw)) {
    return false;
  }
  throw new Error(`${name}: expected a boolean (1/0/true/false), got ${JSON.stringify(value)}`);
}

export function parseInteger(value: string, name = "value"): number {
  const raw = value.trim();
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error(`${name}: expected an integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(raw, 10);
}

export function parseNumber(value: string, name = "value"): number {
  const raw = value.trim();
  const result = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(result)) {
    throw new Error(`${name}: expected a finite number, got ${JSON.stringify(value)}`);
  }
  return result;
}

export function parseString(value: string): string {
  return value.trim();
}

export function parseList(value: string): string[] {
  return splitPatterns(value).map(String);
}

export function parseCaptureProfile(value: string, name = "value"): CaptureProfile {
  const raw = value.trim().toLowerCase();
  if ((CAPTURE_PROFILE_NAMES as readonly string[]).includes(raw)) {
    return raw as CaptureProfile;
  }
  throw new Error(
    `${name}: expected one of ${CAPTURE_PROFILE_NAMES.join("/")}, got ${JSON.stringify(value)}`,
  );
}

/** Flat, camelCase view of every option the environment can set. */
export type EnvConfig = {
  apiKey?: string;
  appId?: string;
  environment?: string;
  baseUrl?: string;
  enabled?: boolean;
  captureProfile?: CaptureProfile;
  captureHeaders?: boolean;
  capturePayloads?: boolean;
  logRequestBody?: boolean;
  logResponseBody?: boolean;
  maxPayloadBytes?: number;
  captureContentTypes?: string[];
  redactQueryParams?: string[];
  redactHeaders?: string[];
  redactBodyFields?: string[];
  excludePaths?: string[];
  excludeUserAgents?: string[];
  defaultExclusions?: boolean;
  sampleRate?: number;
  batchSize?: number;
  flushIntervalMs?: number;
};

type EnvOption = {
  /** Python option name; the variable is `APILENS_` + its upper-case form. */
  option: string;
  key: keyof EnvConfig;
  parse: (value: string, name: string) => unknown;
};

const SECONDS_TO_MS = (value: string, name: string): number =>
  Math.round(parseNumber(value, name) * 1000);

/** Every supported variable, in the same order and spelling as the Python SDK. */
export const ENV_OPTIONS: readonly EnvOption[] = Object.freeze([
  { option: "api_key", key: "apiKey", parse: parseString },
  { option: "app_id", key: "appId", parse: parseString },
  { option: "environment", key: "environment", parse: parseString },
  { option: "base_url", key: "baseUrl", parse: parseString },
  { option: "enabled", key: "enabled", parse: parseBool },
  { option: "capture_profile", key: "captureProfile", parse: parseCaptureProfile },
  { option: "capture_headers", key: "captureHeaders", parse: parseBool },
  { option: "capture_payloads", key: "capturePayloads", parse: parseBool },
  { option: "log_request_body", key: "logRequestBody", parse: parseBool },
  { option: "log_response_body", key: "logResponseBody", parse: parseBool },
  { option: "max_payload_bytes", key: "maxPayloadBytes", parse: parseInteger },
  { option: "capture_content_types", key: "captureContentTypes", parse: parseList },
  { option: "redact_query_params", key: "redactQueryParams", parse: parseList },
  { option: "redact_headers", key: "redactHeaders", parse: parseList },
  { option: "redact_body_fields", key: "redactBodyFields", parse: parseList },
  { option: "exclude_paths", key: "excludePaths", parse: parseList },
  { option: "exclude_user_agents", key: "excludeUserAgents", parse: parseList },
  { option: "default_exclusions", key: "defaultExclusions", parse: parseBool },
  { option: "sample_rate", key: "sampleRate", parse: parseNumber },
  { option: "batch_size", key: "batchSize", parse: parseInteger },
  // Seconds, like the Python SDK; stored as milliseconds.
  { option: "flush_interval", key: "flushIntervalMs", parse: SECONDS_TO_MS },
] satisfies EnvOption[]);

/** `"sample_rate"` → `"APILENS_SAMPLE_RATE"`. */
export function envVar(option: string): string {
  return ENV_PREFIX + option.toUpperCase();
}

function processEnv(): Env {
  // Guarded so the SDK still loads in runtimes without `process` (edge workers).
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * Parse every `APILENS_*` option that is set (and non-empty), e.g.
 * `{ sampleRate: 0.25, redactHeaders: ["^x-secret$"] }`. Unset variables are
 * absent. Throws an `Error` naming the variable for an unparseable value.
 */
export function loadEnvConfig(env: Env = processEnv()): EnvConfig {
  const out: Record<string, unknown> = {};
  for (const { option, key, parse } of ENV_OPTIONS) {
    const name = envVar(option);
    const raw = env[name];
    if (raw === undefined || raw === null || !String(raw).trim()) {
      continue;
    }
    out[key] = parse(String(raw), name);
  }
  return out as EnvConfig;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function anySet(config: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => isSet(config[key]));
}

// Spellings that mean the same option; any one of them counts as explicit.
const ALIASES: Partial<Record<keyof EnvConfig, readonly string[]>> = {
  apiKey: ["apiKey", "api_key", "clientId", "client_id"],
  appId: ["appId", "app_id"],
  baseUrl: ["baseUrl", "base_url"],
  environment: ["environment", "env"],
};

const REQUEST_LOGGING_KEYS: ReadonlySet<keyof EnvConfig> = new Set([
  "captureHeaders",
  "capturePayloads",
  "logRequestBody",
  "logResponseBody",
  "maxPayloadBytes",
]);

/** Merged by the component that owns them (additive), not used as a fallback. */
const ADDITIVE_KEYS: ReadonlySet<keyof EnvConfig> = new Set(["excludePaths", "excludeUserAgents"]);

/**
 * Fill `requestLogging` flags from a capture profile. Only flags left unset
 * are filled, so individual flags always win over the preset. Under
 * `metadata`, an explicit `capturePayloads: true` asks for both bodies, so the
 * preset's body flags are not applied.
 */
export function applyCaptureProfile(
  profile: CaptureProfile | undefined,
  requestLogging: RequestLoggingConfig = {},
): RequestLoggingConfig {
  if (profile === undefined || profile === null) {
    return { ...requestLogging };
  }
  const preset = CAPTURE_PROFILES[profile];
  if (!preset) {
    throw new Error(
      `captureProfile: expected one of ${CAPTURE_PROFILE_NAMES.join("/")}, got ${JSON.stringify(profile)}`,
    );
  }
  const out: RequestLoggingConfig = { ...requestLogging };
  const bodiesRequested = requestLogging.capturePayloads === true;
  for (const [key, value] of Object.entries(preset) as Array<[keyof RequestLoggingConfig, never]>) {
    if (isSet(out[key])) {
      continue;
    }
    if (bodiesRequested && (key === "logRequestBody" || key === "logResponseBody") && value === false) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The effective config: `config` with every `APILENS_*` option it did not set
 * filled from the environment (explicit > env > default), then the capture
 * profile (from code or `APILENS_CAPTURE_PROFILE`) applied to the
 * `requestLogging` flags still unset. `APILENS_EXCLUDE_USER_AGENTS` is
 * appended to `excludeUserAgents`; `APILENS_EXCLUDE_PATHS` is left to
 * `RequestExcluder`, which already adds it. The input is not mutated.
 */
export function resolveConfig<T extends ApiLensExpressConfig>(
  config: T = {} as T,
  env: Env = processEnv(),
): T {
  const fromEnv = loadEnvConfig(env);
  const out: Record<string, unknown> = { ...config };
  const requestLogging: Record<string, unknown> = { ...(config.requestLogging || {}) };

  for (const [key, value] of Object.entries(fromEnv) as Array<[keyof EnvConfig, unknown]>) {
    if (ADDITIVE_KEYS.has(key)) {
      continue;
    }
    if (REQUEST_LOGGING_KEYS.has(key)) {
      if (!isSet(requestLogging[key])) {
        requestLogging[key] = value;
      }
      continue;
    }
    if (!anySet(out, ALIASES[key] ?? [key])) {
      out[key] = value;
    }
  }

  if (fromEnv.excludeUserAgents?.length) {
    out.excludeUserAgents = [...splitPatterns(config.excludeUserAgents), ...fromEnv.excludeUserAgents];
  }

  const profile = out.captureProfile as CaptureProfile | undefined;
  const hasRequestLogging = isSet(config.requestLogging) || Object.keys(requestLogging).length > 0;
  if (isSet(profile) || hasRequestLogging) {
    out.requestLogging = applyCaptureProfile(profile, requestLogging as RequestLoggingConfig);
  }
  return out as T;
}
