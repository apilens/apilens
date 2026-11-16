/**
 * The full exception payload (M5 D3, D4): `name: message`, the stack, then
 * every `Caused by:` from `error.cause` and every `AggregateError` member,
 * capped at 64 KiB keeping the head and the tail.
 */

/** Exception payload cap in characters (the same 64 KiB as ingest). */
export const MAX_EXCEPTION_PAYLOAD_CHARS = 65_536;
/** How many `cause` / AggregateError levels are followed below the raised error. */
export const MAX_CAUSE_DEPTH = 10;
/** Default `Error.stackTraceLimit` applied at init (V8's own default is 10). */
export const DEFAULT_STACK_TRACE_LIMIT = 50;

const MAX_JSON_PREVIEW_CHARS = 2048;
const MAX_ATTRIBUTE_MESSAGE_CHARS = 512;

/**
 * Raise `Error.stackTraceLimit` to `limit` (default 50) unless the app already
 * set it at least that high. A non-positive or non-numeric `limit` falls back
 * to the default.
 */
export function applyStackTraceLimit(limit: number | undefined): void {
  const wanted =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.trunc(limit)
      : DEFAULT_STACK_TRACE_LIMIT;
  try {
    const current = (Error as { stackTraceLimit?: unknown }).stackTraceLimit;
    if (typeof current === "number" && current >= wanted) {
      return;
    }
    (Error as { stackTraceLimit?: number }).stackTraceLimit = wanted;
  } catch {
    // A frozen Error (hardened runtimes) keeps its own limit.
  }
}

/**
 * Cap `text` at `limit` characters keeping the head and the tail with a
 * `\n…[N chars truncated]…\n` marker in the middle, so the raised exception
 * and its root cause both survive. The result never exceeds `limit`.
 */
export function truncateHeadTail(text: string, limit: number = MAX_EXCEPTION_PAYLOAD_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  const keep = limit - marker(text.length).length;
  if (keep <= 0) {
    return text.slice(0, limit);
  }
  const tail = Math.floor(keep / 2);
  let headEnd = keep - tail;
  let tailStart = text.length - tail;
  // Never split a surrogate pair.
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) {
    headEnd -= 1;
  }
  if (isLowSurrogate(text.charCodeAt(tailStart))) {
    tailStart += 1;
  }
  return text.slice(0, headEnd) + marker(tailStart - headEnd) + text.slice(tailStart);
}

function marker(dropped: number): string {
  return `\n…[${dropped} chars truncated]…\n`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export type ExceptionContent = {
  /** `name: message` of the raised error. */
  message: string;
  /** The rendered exception, causes and members included, capped at 64 KiB. */
  payload: string;
  /** `exception.type`, `exception.message`, `exception.chain_depth`. */
  attributes: Record<string, string>;
};

/**
 * Render a thrown value. An `Error` gives its header, stack, causes and
 * AggregateError members; anything else gives `String(value)` and a JSON
 * preview. `exception.chain_depth` counts the `cause` links followed from
 * the raised error (0 when it has no cause).
 */
export function exceptionContent(error: unknown): ExceptionContent {
  const seen = new Set<object>();
  const lines: string[] = [];
  renderValue(error, lines, seen, 0);
  const type = typeName(error);
  const message = error instanceof Error ? String(error.message ?? "") : String(error);
  return {
    message: error instanceof Error ? header(error) : `Error: ${String(error)}`,
    payload: truncateHeadTail(lines.join("\n")),
    attributes: {
      "exception.type": type,
      "exception.message": message.slice(0, MAX_ATTRIBUTE_MESSAGE_CHARS),
      "exception.chain_depth": String(chainDepth(error)),
    },
  };
}

function renderValue(value: unknown, lines: string[], seen: Set<object>, depth: number): void {
  if (!(value instanceof Error)) {
    lines.push(safeString(value));
    // A thrown object prints as "[object Object]": add what it holds.
    const preview = typeof value === "object" && value !== null ? jsonPreview(value) : undefined;
    if (preview !== undefined) {
      lines.push(preview);
    }
    return;
  }
  seen.add(value);
  lines.push(stackOf(value));

  const members = aggregateMembers(value);
  members.forEach((member, i) => {
    const label = `Aggregated error ${i + 1} of ${members.length}: `;
    if (depth >= MAX_CAUSE_DEPTH) {
      lines.push(`${label}[omitted: depth limit ${MAX_CAUSE_DEPTH} reached]`);
    } else if (typeof member === "object" && member !== null && seen.has(member)) {
      lines.push(`${label}[Circular: ${describe(member)}]`);
    } else {
      renderLabelled(label, member, lines, seen, depth + 1);
    }
  });

  if (!hasCause(value)) {
    return;
  }
  const cause = (value as { cause?: unknown }).cause;
  if (depth >= MAX_CAUSE_DEPTH) {
    lines.push(`Caused by: [omitted: depth limit ${MAX_CAUSE_DEPTH} reached]`);
  } else if (typeof cause === "object" && cause !== null && seen.has(cause)) {
    lines.push(`Caused by: [Circular: ${describe(cause)}]`);
  } else {
    renderLabelled("Caused by: ", cause, lines, seen, depth + 1);
  }
}

/** Render `value` with `label` prefixed to its first line. */
function renderLabelled(
  label: string,
  value: unknown,
  lines: string[],
  seen: Set<object>,
  depth: number,
): void {
  const start = lines.length;
  renderValue(value, lines, seen, depth);
  lines[start] = label + (lines[start] ?? "");
}

function chainDepth(error: unknown): number {
  const seen = new Set<unknown>();
  let depth = 0;
  let current: unknown = error;
  while (current instanceof Error && hasCause(current) && depth < MAX_CAUSE_DEPTH) {
    seen.add(current);
    const cause = (current as { cause?: unknown }).cause;
    if (seen.has(cause)) {
      break;
    }
    depth += 1;
    current = cause;
  }
  return depth;
}

function hasCause(error: Error): boolean {
  try {
    return "cause" in error && (error as { cause?: unknown }).cause !== undefined;
  } catch {
    return false;
  }
}

function aggregateMembers(error: Error): unknown[] {
  try {
    const errors = (error as { errors?: unknown }).errors;
    if (
      Array.isArray(errors) &&
      (typeof AggregateError === "undefined" ? false : error instanceof AggregateError)
    ) {
      return errors;
    }
  } catch {
    // A throwing getter: no members.
  }
  return [];
}

/** `name: message`, or just the name when the message is empty. */
function header(error: Error): string {
  const name = safeName(error);
  const message = String(error.message ?? "");
  return message ? `${name}: ${message}` : name;
}

function safeName(error: Error): string {
  try {
    return String(error.name || error.constructor?.name || "Error");
  } catch {
    return "Error";
  }
}

function typeName(value: unknown): string {
  if (value instanceof Error) {
    return safeName(value);
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    try {
      return String((value as object).constructor?.name || "Object");
    } catch {
      return "Object";
    }
  }
  return typeof value;
}

/**
 * The header then the stack frames. V8 puts `name: message` at the top of
 * `error.stack` when the error is created; when the name or message changed
 * since (or the stack has no header) the current header is used instead.
 */
function stackOf(error: Error): string {
  const head = header(error);
  let stack: string;
  try {
    stack = typeof error.stack === "string" ? error.stack : "";
  } catch {
    stack = "";
  }
  if (!stack) {
    return head;
  }
  if (stack.startsWith(head)) {
    return stack;
  }
  const stackLines = stack.split("\n");
  const firstFrame = stackLines.findIndex((line) => /^\s+at\s/.test(line));
  const frames = firstFrame >= 0 ? stackLines.slice(firstFrame) : stackLines;
  return [head, ...frames].join("\n");
}

function describe(value: object): string {
  return value instanceof Error ? header(value) : safeString(value);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** A JSON preview of a non-Error throw (cycle-safe, capped); undefined when it has none. */
function jsonPreview(value: object): string | undefined {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") {
        return v.toString();
      }
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) {
          return "[Circular]";
        }
        seen.add(v);
      }
      return v;
    });
    if (json === undefined) {
      return undefined;
    }
    return json.length > MAX_JSON_PREVIEW_CHARS
      ? `${json.slice(0, MAX_JSON_PREVIEW_CHARS)}…`
      : json;
  } catch {
    return undefined;
  }
}
