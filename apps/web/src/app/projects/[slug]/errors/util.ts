/* Shared types + helpers for the Errors page. */

export interface ErrorGroup {
  status_code: number;
  method: string;
  path: string;
  occurrences: number;
  consumers: number;
  last_seen: string;
  sample_trace_id: string;
}

export interface ErrorEvent {
  timestamp: string;
  method: string;
  path: string;
  status_code: number;
  message: string;
  payload: string;
  logger_name: string;
  consumer_id: string;
  consumer_name: string;
  trace_id: string;
  span_id: string;
  fingerprint?: string;
  release?: string;
  commit_sha?: string;
}

// Code Link (GitHub integration): a probable cause commit for an issue.
export interface SuspectCommit {
  sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_login: string;
  date: string;
  url: string;
  repository: string;
  files: string[];
}

export interface FrameLink {
  path: string;
  line: number;
  function: string;
  mapped_path: string;
  repository: string;
  url: string;
}

export interface SuspectResponse {
  suspect_commits: SuspectCommit[];
  frame_links: FrameLink[];
  reason: string;
}

// Recent-request row (from the endpoint-requests analytics view), used to list a
// status group's individual occurrences (works for 4xx and 5xx alike).
export interface OccurrenceRow {
  timestamp: string;
  method: string;
  path: string;
  raw_path?: string;
  status_code: number;
  response_time_ms: number;
  consumer: string;
  consumer_id?: string;
  trace_id?: string;
}

/** HTTP reason phrases — the human label shown next to the status code (matches
 * the "422 Unprocessable Content" style). Falls back to a class name. */
const REASON: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable",
  407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict",
  410: "Gone", 411: "Length Required", 412: "Precondition Failed",
  413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type",
  416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot",
  421: "Misdirected Request", 422: "Unprocessable Content", 423: "Locked",
  424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required",
  428: "Precondition Required", 429: "Too Many Requests",
  431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected",
  510: "Not Extended", 511: "Network Authentication Required",
};

export function reasonPhrase(status: number): string {
  if (REASON[status]) return REASON[status];
  if (status >= 500) return "Server Error";
  if (status >= 400) return "Client Error";
  return "Error";
}

/** Split "ExceptionType: message" into a bold type + the rest. Falls back to the
 * whole string (e.g. "HTTP 500 on GET /x" has no type). */
export function splitException(message: string): { type: string; rest: string } {
  const m = (message || "").match(/^([\w.]+(?:Error|Exception|Warning|Fault)?):\s+([\s\S]+)$/);
  if (m && /^[\w.]+$/.test(m[1]) && !m[1].startsWith("HTTP")) {
    return { type: m[1], rest: m[2] };
  }
  return { type: "", rest: message || "" };
}
