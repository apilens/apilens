// The sign-in page's "Email code" call (#314): `POST /api/auth/email/start` with
// `{email, intent: "signin", next}`. The Route Handler answers `{ok: true, next}` (the
// "check your inbox" page) or `{ok: false, code, retry_after?}`.
//
// Client-safe: no server imports.

export type EmailStartResult =
  | { ok: true; next: string; retryAfter: number | null }
  | { ok: false; code: string; retryAfter: number | null };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Asks for a sign-in code for `email`. Never throws: transport failures map to `network_error`. */
export async function startEmailSignIn(
  input: { email: string; next?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<EmailStartResult> {
  const body: Record<string, string> = { email: input.email.trim(), intent: "signin" };
  if (input.next) body.next = input.next;
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/email/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, code: "network_error", retryAfter: null };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) data = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy error page): fall through to the status-based code below.
  }
  const retryAfter = num(data.retry_after);
  if (res.ok && data.ok === true && typeof data.next === "string" && data.next.startsWith("/") && !data.next.startsWith("//")) {
    return { ok: true, next: data.next, retryAfter };
  }
  const code = typeof data.code === "string" ? data.code : res.status >= 500 ? "server_error" : "unknown_error";
  return { ok: false, code, retryAfter };
}

/** User-facing copy for a failed `startEmailSignIn`. */
export function emailStartError(code: string, retryAfter: number | null): string {
  switch (code) {
    case "validation_failed":
      return "Enter a work email like you@company.com.";
    case "rate_limited":
      return retryAfter && retryAfter > 0
        ? `Too many codes requested. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`
        : "Too many codes requested. Try again in a moment.";
    case "network_error":
      return "Couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Couldn’t send a code right now. Try again in a moment.";
  }
}
