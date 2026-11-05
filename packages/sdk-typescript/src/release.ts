// Deploy correlation: every record carries the release/commit that produced it
// so the dashboard can answer "did this deploy cause the regression?". Mirrors
// the Python SDK's _detect_release/_detect_commit, plus the Node-hosting
// platforms (Vercel, Heroku) that expose the commit under their own names.

type Env = Record<string, string | undefined>;

export const RELEASE_ENV_VARS = ["APILENS_RELEASE"] as const;

// First non-empty wins; APILENS_COMMIT is the explicit override, the rest are
// what CI / PaaS platforms set on their own.
export const COMMIT_ENV_VARS = [
  "APILENS_COMMIT",
  "GIT_COMMIT",
  "SOURCE_VERSION",
  "RENDER_GIT_COMMIT",
  "VERCEL_GIT_COMMIT_SHA",
  "HEROKU_SLUG_COMMIT",
] as const;

function processEnv(): Env {
  // Guarded so the SDK still loads in runtimes without `process` (edge workers).
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function firstNonEmpty(names: readonly string[], env: Env): string {
  for (const name of names) {
    const value = String(env[name] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function detectRelease(env: Env = processEnv()): string {
  return firstNonEmpty(RELEASE_ENV_VARS, env);
}

export function detectCommit(env: Env = processEnv()): string {
  return firstNonEmpty(COMMIT_ENV_VARS, env);
}
