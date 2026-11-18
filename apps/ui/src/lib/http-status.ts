// HTTP reason phrases (#1052, #1053): the words beside a status code in Explore's facets, its
// status tooltips and the request panel ("404 Not Found"). RFC 9110 names, plus 429 (RFC 6585).
// Unit-tested in http-status.test.ts.

const REASONS: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  507: "Insufficient Storage",
  508: "Loop Detected",
  511: "Network Authentication Required",
};

const CLASS_WORDS: Record<string, string> = {
  "1xx": "Informational",
  "2xx": "Success",
  "3xx": "Redirection",
  "4xx": "Client error",
  "5xx": "Server error",
};

/** The reason phrase of a status code ("Not Found"), or "" for a code without one. */
export function reasonPhrase(code: number): string {
  return REASONS[code] ?? "";
}

/** A status code with its reason phrase: `404 Not Found`; a code without one reads as the code. */
export function statusText(code: number): string {
  const r = reasonPhrase(code);
  return r ? `${code} ${r}` : String(code);
}

/** What a status class means: `4xx` → `Client error`; "" for anything else. */
export function classWords(cls: string): string {
  return CLASS_WORDS[cls] ?? "";
}
