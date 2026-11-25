/**
 * Parsing the full exception payload of an `apilens.exception` log (#924) into blocks of frames,
 * one block per exception in the chain: Python `traceback.format_exception` text, a Node `stack`
 * with the SDK's `Caused by:` / `Aggregated error` lines, and a JVM `printStackTrace`. Anything
 * else stays raw text. Pure and framework-free so it is unit tested on its own.
 */

export type StackFormat = "python" | "node" | "java" | "raw";

/** How a block relates to the raised exception. */
export type BlockRelation = "raised" | "cause" | "context" | "suppressed" | "member";

export interface StackFrame {
  /** Function or method name; empty when the line names none. */
  fn: string;
  /** File path, module or class location; empty when unknown. */
  file: string;
  line: number | null;
  /** Source line Python prints under the frame. */
  code: string;
  /** True when the frame is the app's own code rather than a library or the runtime. */
  inApp: boolean;
  /** A line of the block that is not a frame (e.g. `... 5 more`, a cut line). */
  note?: string;
}

export interface ExceptionBlock {
  relation: BlockRelation;
  /** Label shown on the block, e.g. "Caused by" or "Sub-exception 2". */
  label: string;
  type: string;
  message: string;
  frames: StackFrame[];
}

export interface ParsedException {
  format: StackFormat;
  /** Raised exception first, then its causes. Empty for `raw`. */
  blocks: ExceptionBlock[];
  /** Characters the SDK or ingest cut from the middle, or null when the payload is whole. */
  truncated: number | null;
}

/** The head+tail cap marker (M5 D4): `\n…[N chars truncated]…\n`. */
const TRUNCATED = /\n?…\[(\d+) chars truncated\]…\n?/;

/** `Type: message` split at the first `: `; a line without one is all type. */
export function splitHeader(header: string): { type: string; message: string } {
  const at = header.indexOf(": ");
  if (at <= 0) return { type: header.trim(), message: "" };
  return { type: header.slice(0, at).trim(), message: header.slice(at + 2) };
}

// ---------------------------------------------------------------- python

const PY_FRAME = /^\s*File "(.+)", line (\d+)(?:, in (.+))?$/;
const PY_CAUSE = "The above exception was the direct cause of the following exception:";
const PY_CONTEXT = "During handling of the above exception, another exception occurred:";
const PY_GROUP_SEP = /^\s*\+?-?\+?-+ (\d+|\.\.\.) -+$|^\s*\+-+$/;
/** Leading `  | ` / `  + ` decoration of ExceptionGroup output, any depth. */
const PY_GROUP_PREFIX = /^(?:\s*[|+] )+/;

const pyInApp = (file: string) => !/site-packages|dist-packages|[\\/]lib[\\/]python\d|^<frozen |^<string>$/.test(file);

/** Parse `traceback.format_exception` text. Python prints the chain root first; we show it raised first. */
export function parsePython(text: string): ExceptionBlock[] {
  type Seg = { link: "cause" | "context" | "member" | null; member: string; lines: string[] };
  const segs: Seg[] = [];
  let cur: Seg = { link: null, member: "", lines: [] };
  let inGroup = false;
  const push = (next: Seg) => {
    if (cur.lines.some((l) => l.trim())) segs.push(cur);
    cur = next;
  };
  for (const rawLine of text.split("\n")) {
    if (/^\s*\+ Exception Group Traceback/.test(rawLine)) inGroup = true;
    const sep = inGroup ? rawLine.match(PY_GROUP_SEP) : null;
    if (sep) {
      if (sep[1]) push({ link: "member", member: sep[1], lines: [] });
      continue;
    }
    const line = inGroup ? rawLine.replace(PY_GROUP_PREFIX, "") : rawLine;
    const trimmed = line.trim();
    if (trimmed === PY_CAUSE || trimmed === PY_CONTEXT) {
      push({ link: trimmed === PY_CAUSE ? "cause" : "context", member: "", lines: [] });
      continue;
    }
    // A traceback after a header with no separator between them (the cap cut it out) still
    // starts a new exception.
    if (/^(Exception Group )?Traceback \(most recent call last\):$/.test(trimmed) && cur.lines.some((l) => /^\S/.test(l) && !/^(Exception Group )?Traceback /.test(l))) {
      push({ link: null, member: "", lines: [] });
    }
    cur.lines.push(line);
  }
  push({ link: null, member: "", lines: [] });

  const parsed = segs.map((s) => ({ seg: s, block: pythonBlock(s.lines) }));
  // The top-level chain (before any group member) is printed root first: reverse it so the
  // raised exception leads. Each separator says how the block above relates to the one below.
  const firstMember = parsed.findIndex((p) => p.seg.link === "member");
  const top = firstMember === -1 ? parsed : parsed.slice(0, firstMember);
  const rest = firstMember === -1 ? [] : parsed.slice(firstMember);
  const out: ExceptionBlock[] = [];
  for (let i = top.length - 1; i >= 0; i--) {
    const below = top[i + 1];
    const b = top[i].block;
    if (!below) out.push({ ...b, relation: "raised", label: "Raised" });
    else if (below.seg.link === "context") out.push({ ...b, relation: "context", label: "While handling" });
    else out.push({ ...b, relation: "cause", label: "Caused by" });
  }
  let member = "";
  for (const { seg, block } of rest) {
    if (seg.link === "member") member = seg.member;
    const label = seg.link === "member" ? `Sub-exception ${seg.member}` : seg.link === "context" ? `Sub-exception ${member}, while handling` : `Sub-exception ${member}, caused by`;
    out.push({ ...block, relation: seg.link === "member" ? "member" : seg.link === "context" ? "context" : "cause", label });
  }
  return out;
}

function pythonBlock(lines: string[]): ExceptionBlock {
  const frames: StackFrame[] = [];
  const header: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (header.length) {
      header.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || /^(Exception Group )?Traceback \(most recent call last\):$/.test(trimmed)) continue;
    const f = line.match(PY_FRAME);
    if (f) {
      const next = lines[i + 1];
      const code = next !== undefined && /^\s{4,}\S/.test(next) && !PY_FRAME.test(next) ? next.trim() : "";
      if (code) i++;
      // Skip the `^^^^` caret line Python 3.11+ prints under the code.
      while (lines[i + 1] !== undefined && /^\s+[~^]+\s*$/.test(lines[i + 1])) i++;
      frames.push({ fn: f[3] ?? "", file: f[1], line: Number(f[2]), code, inApp: pyInApp(f[1]) });
    } else if (/^\s/.test(line)) {
      frames.push({ fn: "", file: "", line: null, code: "", inApp: false, note: trimmed });
    } else {
      header.push(line);
    }
  }
  while (header.length > 1 && !header[header.length - 1].trim()) header.pop();
  const { type, message } = splitHeader(header[0] ?? "");
  const rest = header.slice(1).join("\n");
  return { relation: "raised", label: "", type, message: rest ? `${message}\n${rest}` : message, frames };
}

// ---------------------------------------------------------------- node

const NODE_FRAME = /^\s+at (?:(?:async |new )?(.+?) \((.+?)\)|(.+?))$/;
const NODE_CAUSE = /^\s*Caused by: (.*)$/;
const NODE_MEMBER = /^\s*Aggregated error (\d+) of (\d+): (.*)$/;

const nodeInApp = (file: string) => !/node_modules|^node:|^internal[\\/]|^<anonymous>$|^native$/.test(file);

function nodeFrame(line: string): StackFrame | null {
  const m = line.match(NODE_FRAME);
  if (!m) return null;
  const loc = m[2] ?? m[3] ?? "";
  const fn = m[2] !== undefined ? (m[1] ?? "") : "";
  const pos = loc.match(/^(.*?):(\d+)(?::\d+)?$/);
  const file = pos ? pos[1] : loc;
  return { fn, file, line: pos ? Number(pos[2]) : null, code: "", inApp: nodeInApp(file) };
}

/** Parse a Node `stack` with the TypeScript SDK's `Caused by:` and `Aggregated error i of n:` lines. */
export function parseNode(text: string): ExceptionBlock[] {
  const out: ExceptionBlock[] = [];
  let cur: ExceptionBlock | null = null;
  let header: string[] = [];
  const start = (relation: BlockRelation, label: string, first: string) => {
    flush();
    cur = { relation, label, type: "", message: "", frames: [] };
    header = [first];
  };
  const flush = () => {
    if (!cur) return;
    const { type, message } = splitHeader(header[0] ?? "");
    const rest = header.slice(1).join("\n");
    out.push({ ...cur, type, message: rest ? `${message}\n${rest}` : message });
    cur = null;
  };
  for (const line of text.split("\n")) {
    const cause = line.match(NODE_CAUSE);
    const member = line.match(NODE_MEMBER);
    if (cause) start("cause", "Caused by", cause[1]);
    else if (member) start("member", `Aggregated error ${member[1]} of ${member[2]}`, member[3]);
    else if (!cur) {
      if (line.trim()) start("raised", "Raised", line);
    } else {
      const f = nodeFrame(line);
      const block = cur as ExceptionBlock;
      if (f) block.frames.push(f);
      else if (block.frames.length) {
        if (line.trim()) block.frames.push({ fn: "", file: "", line: null, code: "", inApp: false, note: line.trim() });
      } else header.push(line);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- java

const JAVA_FRAME = /^\s+at (?:[\w.$-]+\/)*([\w$.<>]+)\.([\w$<>-]+)\((.*?)\)$/;
const JAVA_CAUSE = /^\s*Caused by: (.*)$/;
const JAVA_SUPPRESSED = /^\s*Suppressed: (.*)$/;
const JAVA_LIBRARY = /^(java|javax|jakarta|jdk|sun|com\.sun|kotlin|kotlinx|scala|org\.springframework|org\.apache|org\.eclipse|org\.hibernate|io\.netty|reactor|io\.micrometer|com\.fasterxml|ai\.apilens)\./;

function javaFrame(line: string): StackFrame | null {
  const m = line.match(JAVA_FRAME);
  if (!m) return null;
  const pos = m[3].match(/^(.*?):(\d+)$/);
  return { fn: `${m[1]}.${m[2]}`, file: pos ? pos[1] : m[3], line: pos ? Number(pos[2]) : null, code: "", inApp: !JAVA_LIBRARY.test(m[1]) };
}

/** Parse a JVM `printStackTrace`: the raised throwable, then every `Caused by:` and `Suppressed:`. */
export function parseJava(text: string): ExceptionBlock[] {
  const out: ExceptionBlock[] = [];
  let cur: ExceptionBlock | null = null;
  let header: string[] = [];
  const flush = () => {
    if (!cur) return;
    const { type, message } = splitHeader(header[0] ?? "");
    const rest = header.slice(1).join("\n");
    out.push({ ...cur, type, message: rest ? `${message}\n${rest}` : message });
    cur = null;
  };
  const start = (relation: BlockRelation, label: string, first: string) => {
    flush();
    cur = { relation, label, type: "", message: "", frames: [] };
    header = [first];
  };
  for (const line of text.split("\n")) {
    const cause = line.match(JAVA_CAUSE);
    const suppressed = line.match(JAVA_SUPPRESSED);
    if (cause) start("cause", "Caused by", cause[1]);
    else if (suppressed) start("suppressed", "Suppressed", suppressed[1]);
    else if (!cur) {
      if (line.trim()) start("raised", "Raised", line);
    } else {
      const f = javaFrame(line);
      const block = cur as ExceptionBlock;
      if (f) block.frames.push(f);
      else if (block.frames.length || /^\s+\.\.\. \d+ more$/.test(line)) {
        if (line.trim()) block.frames.push({ fn: "", file: "", line: null, code: "", inApp: false, note: line.trim() });
      } else header.push(line);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- detection

/** Which runtime printed this payload. */
export function detectFormat(text: string): StackFormat {
  if (/^\s*(?:[|+] )*(?:Exception Group )?Traceback \(most recent call last\):\s*$/m.test(text)) return "python";
  if (/^\s+at [\w$.<>/-]+\([^()]*\.(?:java|kt|scala|groovy):\d+\)$|^\s+at [\w$.<>/-]+\((?:Native Method|Unknown Source)\)$/m.test(text)) return "java";
  if (/^\s+at .+(?::\d+:\d+\)?|\(native\)|\(<anonymous>\))$/m.test(text)) return "node";
  return "raw";
}

/**
 * Parse an exception payload. The truncation marker is lifted out and reported; when no block
 * has a frame the payload is left as raw text.
 */
export function parseException(payload: string): ParsedException {
  const marker = payload.match(TRUNCATED);
  const truncated = marker ? Number(marker[1]) : null;
  const text = (marker ? payload.replace(TRUNCATED, "\n") : payload).replace(/\r\n/g, "\n");
  const format = detectFormat(text);
  const blocks = format === "python" ? parsePython(text) : format === "node" ? parseNode(text) : format === "java" ? parseJava(text) : [];
  if (!blocks.some((b) => b.frames.some((f) => !f.note))) return { format: "raw", blocks: [], truncated };
  return { format, blocks, truncated };
}

/** Logger name of the log record holding a request's full exception (M5 D3). */
export const EXCEPTION_LOGGER = "apilens.exception";

/** The trace's exception log, preferring one with a payload, or null when the trace has none. */
export function exceptionLog<L extends { logger_name?: string; payload?: string }>(logs: readonly L[]): L | null {
  const all = logs.filter((l) => l.logger_name === EXCEPTION_LOGGER);
  return all.find((l) => l.payload) ?? all[0] ?? null;
}

/**
 * Every exception of the trace, in the order they were raised; one reported twice (same message
 * and stack) shows once. A request that logged an error and then failed with another has two.
 */
export function exceptionLogs<L extends { logger_name?: string; payload?: string; message?: string; timestamp?: string }>(logs: readonly L[]): L[] {
  const seen = new Set<string>();
  return logs
    .filter((l) => l.logger_name === EXCEPTION_LOGGER)
    .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))
    .filter((l) => {
      const key = `${l.message ?? ""}\u0000${l.payload ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Where a frame is, as one line: `file:line in fn`. */
export function frameLocation(f: StackFrame): string {
  const at = f.line !== null ? `${f.file}:${f.line}` : f.file;
  return f.fn && at ? `${at} in ${f.fn}` : f.fn || at;
}
