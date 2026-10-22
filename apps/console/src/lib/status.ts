// HTTP status → meaning. Color is never the only signal: every tone ships with
// a word.

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export function statusTone(code: number): Tone {
  if (code >= 500) return "danger";
  if (code >= 400) return "warning";
  if (code >= 200 && code < 300) return "success";
  return "neutral";
}

const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No content",
  301: "Moved permanently",
  302: "Found",
  304: "Not modified",
  307: "Temporary redirect",
  308: "Permanent redirect",
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  408: "Request timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload too large",
  415: "Unsupported media type",
  422: "Unprocessable content",
  429: "Too many requests",
  500: "Internal server error",
  501: "Not implemented",
  502: "Bad gateway",
  503: "Service unavailable",
  504: "Gateway timeout",
};

/** The reason phrase when we know it, otherwise the status class in words. */
export function statusWord(code: number): string {
  const reason = REASONS[code];
  if (reason) return reason;
  if (code >= 500) return "Server error";
  if (code >= 400) return "Client error";
  if (code >= 300) return "Redirect";
  if (code >= 200) return "OK";
  return "Unknown";
}

export function levelTone(level: string): Tone {
  switch (level.toUpperCase()) {
    case "CRITICAL":
    case "ERROR":
      return "danger";
    case "WARNING":
    case "WARN":
      return "warning";
    default:
      return "neutral";
  }
}
