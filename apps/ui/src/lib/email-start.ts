// Browser side of `POST /api/auth/email/start` (#313): asks the Route Handler to email a sign-in
// code and turns its answer into something a form can render. Client-safe: no server imports.

export type EmailIntent = "signin" | "signup";

export interface EmailStartInput {
  email: string;
  intent: EmailIntent;
  /** Same-origin path to land on after verifying; the Route Handler re-checks it. */
  next?: string;
}

export type EmailStartResult =
  /** Code sent: go to `next` (the `/verify` page, already carrying `retry_after`). */
  | { kind: "sent"; next: string; retryAfter: number | null }
  /** Too many attempts: wait `retryAfter` seconds. */
  | { kind: "rate_limited"; retryAfter: number }
  /** No answer: the browser is offline, or identity is unreachable behind the Route Handler. */
  | { kind: "network" }
  /**
   * Any other refusal, by stable `code`. `sso_required` (#323): the domain's organization enforces
   * SSO, no code was sent, and `startUrl` (when known) is where its SSO starts.
   */
  | { kind: "error"; code: string; startUrl?: string };

/** Seconds to show when a 429 carries no `Retry-After`. */
export const DEFAULT_RETRY_AFTER = 60;

const ENDPOINT = "/api/auth/email/start";

/** Codes the Route Handler answers when identity itself could not be reached. */
const UNREACHABLE = new Set(["network_error", "timeout", "unavailable", "http_502", "http_503", "http_504"]);

function seconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

/** Adds `retry_after` to a same-origin `/verify?…` target so the resend cooldown starts where the server says. */
export function withRetryAfter(next: string, retryAfter: number | null): string {
  if (retryAfter == null) return next;
  const [path, query = ""] = next.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("retry_after", String(retryAfter));
  return `${path}?${params}`;
}

/** The `/verify` page to fall back to if the Route Handler answers without `next`. */
function verifyPath(input: EmailStartInput): string {
  const q = new URLSearchParams({ flow: input.intent, email: input.email });
  if (input.next) q.set("next", input.next);
  return `/verify?${q}`;
}

/** Sends the code. Never throws: transport failures come back as `{kind: "network"}`. */
export async function startEmail(input: EmailStartInput, fetcher: typeof fetch = fetch): Promise<EmailStartResult> {
  let res: Response;
  try {
    res = await fetcher(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: input.email, intent: input.intent, ...(input.next ? { next: input.next } : {}) }),
    });
  } catch {
    return { kind: "network" };
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // A proxy error page or empty body: fall through on the status alone.
  }

  const retryAfter = seconds(body.retry_after) ?? seconds(res.headers.get("retry-after"));

  if (res.ok && body.ok === true) {
    const target = typeof body.next === "string" && body.next.startsWith("/verify") ? body.next : verifyPath(input);
    return { kind: "sent", next: withRetryAfter(target, retryAfter), retryAfter };
  }
  if (res.status === 429 || body.code === "rate_limited") {
    return { kind: "rate_limited", retryAfter: retryAfter ?? DEFAULT_RETRY_AFTER };
  }
  const code = typeof body.code === "string" && body.code !== "" ? body.code : `http_${res.status}`;
  if (code === "sso_required" && typeof body.start_url === "string") {
    return { kind: "error", code, startUrl: body.start_url };
  }
  if (UNREACHABLE.has(code)) return { kind: "network" };
  return { kind: "error", code };
}

/** Inline copy when the code could not be sent for lack of a connection. */
export const NETWORK_MESSAGE = "We couldn’t reach APILens. Check your connection and try again.";

/** Inline copy for a rate limit, counting down. */
export function rateLimitMessage(secondsLeft: number): string {
  const n = Math.max(1, Math.ceil(secondsLeft));
  return `Too many attempts. Try again in ${n} ${n === 1 ? "second" : "seconds"}.`;
}

/** Inline copy for a refusal `code` (sentence case, no exclamation marks). */
export function errorMessage(code: string): string {
  switch (code) {
    case "validation_failed":
    case "invalid_email":
      return "Enter a work email like you@company.com.";
    case "sso_required":
      return "Your organization requires single sign-on. Continue with SSO instead.";
    default:
      return "Something went wrong sending your code. Try again.";
  }
}
