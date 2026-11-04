// Server-only runtime configuration for the UI.
//
// Variables are read and validated on first use, never at import time, so
// `next build` succeeds without them: the same image is promoted to every
// environment and configured only when it starts. Importing this module from
// a Client Component is a build error (`server-only`), which keeps
// SESSION_SECRET out of the browser bundle.
import "server-only";

export interface ServerEnv {
  /** Base URL of the APILens backend (identity + dashboard API), no trailing slash. */
  apiUrl: string;
  /** Key that encrypts the httpOnly session cookie (at least 32 characters). */
  sessionSecret: string;
  /** Public origin users reach the UI at, no trailing slash (links, redirects, cookie scope). */
  publicUrl: string;
  /**
   * Base URL browsers reach the APILens API at, no trailing slash: the social sign-in buttons
   * navigate there (`/api/v1/auth/oauth/{provider}/start`). Defaults to {@link apiUrl}, which is
   * only right when that address is public too.
   */
  publicApiUrl: string;
  /**
   * Public base URL SDKs and OpenTelemetry exporters send events to (the edge, port 8080), no
   * trailing slash: the onboarding install snippets use it. Defaults to `http://localhost:8080`.
   */
  publicIngestUrl: string;
}

/** {@link ServerEnv.publicIngestUrl} when `APILENS_PUBLIC_INGEST_URL` is not set. */
export const DEFAULT_PUBLIC_INGEST_URL = "http://localhost:8080";

export const SESSION_SECRET_MIN_LENGTH = 32;

/** Thrown when a required variable is missing or malformed. Names the variable. */
export class EnvError extends Error {
  readonly variable: string;

  constructor(variable: string, problem: string) {
    super(`Invalid environment: ${variable} ${problem} (see apps/ui/README.md).`);
    this.name = "EnvError";
    this.variable = variable;
  }
}

type Source = Record<string, string | undefined>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(name, "is not set");
  return value;
}

function httpUrl(source: Source, name: string): string {
  const raw = required(source, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvError(name, `must be an absolute URL, got "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EnvError(name, `must use http or https, got "${url.protocol}"`);
  }
  if (url.search || url.hash) {
    throw new EnvError(name, "must not contain a query string or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/** Parses and validates a variable source. Exported for tests; use {@link env} in app code. */
export function parseEnv(source: Source): ServerEnv {
  const apiUrl = httpUrl(source, "APILENS_API_URL");
  const sessionSecret = required(source, "SESSION_SECRET");
  if (sessionSecret.length < SESSION_SECRET_MIN_LENGTH) {
    throw new EnvError(
      "SESSION_SECRET",
      `must be at least ${SESSION_SECRET_MIN_LENGTH} characters (generate one with: openssl rand -hex 32)`,
    );
  }
  const publicUrl = httpUrl(source, "APILENS_PUBLIC_URL");
  const publicApiUrl = source.APILENS_PUBLIC_API_URL?.trim() ? httpUrl(source, "APILENS_PUBLIC_API_URL") : apiUrl;
  const publicIngestUrl = source.APILENS_PUBLIC_INGEST_URL?.trim() ? httpUrl(source, "APILENS_PUBLIC_INGEST_URL") : DEFAULT_PUBLIC_INGEST_URL;
  return { apiUrl, sessionSecret, publicUrl, publicApiUrl, publicIngestUrl };
}

let cached: ServerEnv | undefined;

/** The validated server configuration. Reads process.env once, on first call. */
export function env(): ServerEnv {
  cached ??= Object.freeze(parseEnv(process.env));
  return cached;
}
