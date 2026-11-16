/**
 * Database spans (D8): one child `db` span per statement run while handling
 * a request, for `pg`, `mysql2` and Prisma.
 *
 * `pg` and `mysql2` are patched once per process on their connection
 * prototype (`Client.prototype.query`, `Connection.prototype.query` /
 * `execute`), so pools and `mysql2/promise` are covered too. Prisma has no
 * prototype to patch: `instrumentPrisma(prisma)` returns a client extended
 * with a `$allOperations` hook, which the app uses in place of the original.
 *
 * The statement is never sent as written: string, number and hex literals
 * become `?`, comments are removed and it is cut to 2 KiB
 * (`obfuscateSql`). Bound parameters (`$1`, `?`) are never read.
 */

import type * as nodeModule from "node:module";
import type * as nodePath from "node:path";

import { builtin, processObject } from "./runtime.js";
import { currentTraceContext, generateSpanId, type TraceContext } from "./trace.js";

/** Longest `db.statement` sent, after obfuscation. */
export const MAX_DB_STATEMENT_CHARS = 2048;
const MAX_DB_NAME_CHARS = 256;

const WRAPPED = Symbol.for("apilens.wrapped");

type Dialect = "postgresql" | "mysql" | "other";

// One pass over the statement; the first alternative that matches wins, so
// a quote inside a comment or a digit inside a string is never seen alone.
// Groups: 1 line/block comment, 2 dollar-quoted string (its tag is 3),
// 4 single-quoted string (with an optional E/N/X/B prefix), 5 double-quoted
// text, 6 backtick identifier, 7 unterminated quote, 8 hex number,
// 9 number.
const SQL_TOKENS = new RegExp(
  [
    String.raw`(--[^\n]*|/\*[\s\S]*?\*/)`,
    String.raw`(\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\3\$)`,
    String.raw`((?<![\w$])[EeNnXxBb]?'(?:[^'\\]|\\[\s\S]|'')*')`,
    String.raw`("(?:[^"\\]|\\[\s\S]|"")*")`,
    String.raw`(\x60[^\x60]*\x60)`,
    String.raw`((?<![\w$])[EeNnXxBb]?['"][\s\S]*$)`,
    String.raw`((?<![\w$.])0[xX][0-9a-fA-F]+\b)`,
    String.raw`((?<![\w$.])(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?![\w$]))`,
  ].join("|"),
  "g",
);

/**
 * `statement` with every literal replaced by `?`: strings (`'…'`, `E'…'`,
 * `$tag$…$tag$`, and `"…"` for MySQL, where it is a string), numbers and
 * hex. Comments are removed, whitespace collapsed, and the result cut to
 * 2 KiB. Identifiers (`"col"` on PostgreSQL, `` `col` ``) and placeholders
 * (`$1`, `?`, `:name`) are kept.
 */
export function obfuscateSql(statement: string, system = "other"): string {
  const dialect: Dialect = system === "mysql" ? "mysql" : system === "postgresql" ? "postgresql" : "other";
  const out = String(statement ?? "").replace(
    SQL_TOKENS,
    (match, comment, dollar, _tag, single, double, backtick) => {
      if (comment !== undefined) {
        return " ";
      }
      if (dollar !== undefined) {
        // `$tag$…$tag$` (PostgreSQL).
        return "?";
      }
      if (single !== undefined) {
        return "?";
      }
      if (double !== undefined) {
        // A quoted identifier on PostgreSQL (and standard SQL), a string on MySQL.
        return dialect === "mysql" ? "?" : match;
      }
      if (backtick !== undefined) {
        return match;
      }
      return "?";
    },
  );
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_DB_STATEMENT_CHARS);
}

/** The statement's first keyword, upper-cased (`SELECT`, `INSERT`, …), or "". */
export function sqlOperation(statement: string): string {
  const match = /^[\s(]*([A-Za-z]+)/.exec(statement);
  return match ? match[1].toUpperCase() : "";
}

/** One statement in flight: finished once with its outcome. */
type DbCall = {
  ctx: TraceContext;
  spanId: string;
  system: string;
  operation: string;
  statement: string;
  name: string;
  startedAt: Date;
  t0: number;
  done: boolean;
};

/**
 * Start a `db` span for `rawStatement` when a request is being traced;
 * undefined otherwise (outside a request, or spans off). `name` overrides
 * the span name (Prisma's `Model.operation`).
 */
function beginDb(system: string, rawStatement: string, extra?: { operation?: string; name?: string }): DbCall | undefined {
  const ctx = currentTraceContext();
  if (!ctx?.sink) {
    return undefined;
  }
  const statement = obfuscateSql(rawStatement, system);
  const operation = extra?.operation || sqlOperation(statement);
  return {
    ctx,
    spanId: generateSpanId(),
    system,
    operation,
    statement,
    name: (extra?.name || statement || `${system} ${operation}`.trim()).slice(0, MAX_DB_NAME_CHARS),
    startedAt: new Date(),
    t0: performance.now(),
    done: false,
  };
}

function finishDb(call: DbCall | undefined, error: unknown): void {
  if (!call || call.done) {
    return;
  }
  call.done = true;
  try {
    const failed = error !== undefined && error !== null;
    call.ctx.sink?.childSpan({
      spanId: call.spanId,
      name: call.name,
      kind: "db",
      startedAt: call.startedAt,
      durationMs: Math.max(performance.now() - call.t0, 0),
      status: failed ? "error" : "ok",
      statusCode: 0,
      attributes: {
        "db.system": call.system,
        ...(call.operation ? { "db.operation": call.operation } : {}),
        ...(call.statement ? { "db.statement": call.statement } : {}),
        ...(failed ? { "error.type": errorType(error) } : {}),
      },
    });
  } catch {
    // Never break the caller's query over span bookkeeping.
  }
}

function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  return typeof error;
}

/** The SQL text of a driver call's first argument (string or `{ text }` / `{ sql }`). */
function statementOf(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg && typeof arg === "object") {
    const query = arg as { text?: unknown; sql?: unknown };
    if (typeof query.text === "string") {
      return query.text;
    }
    if (typeof query.sql === "string") {
      return query.sql;
    }
  }
  return "";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

/** Finish `call` when an event-emitting query object ends or fails. */
function watchEmitter(result: unknown, call: DbCall): boolean {
  const emitter = result as { emit?: (event: string | symbol, ...args: unknown[]) => boolean } | undefined;
  if (!emitter || typeof emitter.emit !== "function") {
    return false;
  }
  // Wrapping emit instead of adding listeners keeps the driver's semantics:
  // an unhandled 'error' still throws.
  const emit = emitter.emit;
  emitter.emit = function patchedEmit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error") {
      finishDb(call, args[0] ?? new Error("query error"));
    } else if (event === "end") {
      finishDb(call, undefined);
    }
    return emit.call(this, event, ...args);
  };
  return true;
}

type QueryFn = (...args: unknown[]) => unknown;

/**
 * Wrap a driver's query method: callback, promise and event-emitter results
 * all finish the span. The original's result is returned untouched.
 */
function wrapQuery(original: QueryFn, system: string): QueryFn {
  const wrapped = function apilensQuery(this: unknown, ...args: unknown[]): unknown {
    let call: DbCall | undefined;
    try {
      call = beginDb(system, statementOf(args[0]));
    } catch {
      call = undefined;
    }
    if (!call) {
      return original.apply(this, args);
    }
    const active = call;
    const last = args.length - 1;
    if (last >= 0 && typeof args[last] === "function") {
      const callback = args[last] as (...cbArgs: unknown[]) => unknown;
      args[last] = function apilensQueryCallback(this: unknown, ...cbArgs: unknown[]): unknown {
        finishDb(active, cbArgs[0]);
        return callback.apply(this, cbArgs);
      };
    } else if (args[0] && typeof args[0] === "object") {
      // pg: `client.query({ text, callback })`; mysql2 pools pass a prepared
      // Query command whose `onResult` gets the error.
      const config = args[0] as Record<string, unknown>;
      const key = typeof config.callback === "function" ? "callback" : typeof config.onResult === "function" ? "onResult" : "";
      if (key) {
        const callback = config[key] as (...cbArgs: unknown[]) => unknown;
        config[key] = function apilensQueryCallback(this: unknown, ...cbArgs: unknown[]): unknown {
          finishDb(active, cbArgs[0]);
          return callback.apply(this, cbArgs);
        };
      }
    }
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      finishDb(active, error);
      throw error;
    }
    if (!active.done) {
      try {
        if (isThenable(result)) {
          result.then(
            () => finishDb(active, undefined),
            (error: unknown) => finishDb(active, error ?? new Error("query failed")),
          );
        } else {
          watchEmitter(result, active);
        }
      } catch {
        // Leave the span unfinished rather than fail the query.
      }
    }
    return result;
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped;
}

function patchMethod(proto: unknown, method: string, system: string): boolean {
  if (!proto || (typeof proto !== "object" && typeof proto !== "function")) {
    return false;
  }
  const target = proto as Record<string, unknown>;
  const current = target[method] as (QueryFn & { [WRAPPED]?: boolean }) | undefined;
  if (typeof current !== "function") {
    return false;
  }
  if (current[WRAPPED]) {
    return true;
  }
  target[method] = wrapQuery(current, system);
  return true;
}

/**
 * Trace statements run through `pg` (the module `require("pg")` returns):
 * `Client#query`, which `Pool#query` uses too. Idempotent; never throws.
 * Returns true when the module was patched.
 */
export function instrumentPg(pg: unknown): boolean {
  try {
    const Client = (pg as { Client?: { prototype?: unknown } } | undefined)?.Client;
    return patchMethod(Client?.prototype, "query", "postgresql");
  } catch {
    return false;
  }
}

/**
 * Trace statements run through `mysql2` (the module `require("mysql2")`
 * returns): `Connection#query` and `Connection#execute`, which pools and
 * `mysql2/promise` go through. Idempotent; never throws. Returns true when
 * the module was patched.
 */
export function instrumentMysql2(mysql2: unknown): boolean {
  try {
    const Connection = (mysql2 as { Connection?: { prototype?: unknown } } | undefined)?.Connection;
    const query = patchMethod(Connection?.prototype, "query", "mysql");
    const execute = patchMethod(Connection?.prototype, "execute", "mysql");
    return query || execute;
  } catch {
    return false;
  }
}

/** The SQL of a Prisma raw operation's arguments; "" for model operations. */
function prismaRawSql(args: unknown): string {
  if (typeof args === "string") {
    return args;
  }
  if (Array.isArray(args)) {
    const [first] = args as unknown[];
    if (typeof first === "string") {
      return first;
    }
    if (Array.isArray(first)) {
      // A tagged template's strings: the values are bound, never inlined.
      return (first as unknown[]).map(String).join("?");
    }
    return prismaRawSql(first);
  }
  if (args && typeof args === "object") {
    const sql = args as { sql?: unknown; text?: unknown; strings?: unknown };
    if (typeof sql.sql === "string") {
      return sql.sql;
    }
    if (typeof sql.text === "string") {
      return sql.text;
    }
    if (Array.isArray(sql.strings)) {
      return (sql.strings as unknown[]).map(String).join("?");
    }
  }
  return "";
}

type PrismaOperation = {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => PromiseLike<unknown>;
};

type PrismaLike = {
  $extends?: (extension: unknown) => unknown;
};

/**
 * `prisma` extended so each operation run while handling a request becomes
 * a `db` span (`User.findMany`, or the obfuscated SQL of `$queryRaw` and
 * friends). Use the returned client in place of `prisma`; a client without
 * `$extends` (Prisma < 4.16) is returned unchanged.
 */
export function instrumentPrisma<T>(prisma: T): T {
  const client = prisma as unknown as PrismaLike;
  if (!client || typeof client.$extends !== "function") {
    return prisma;
  }
  try {
    return client.$extends({
      name: "apilens",
      query: {
        async $allOperations({ model, operation, args, query }: PrismaOperation): Promise<unknown> {
          let call: DbCall | undefined;
          try {
            const raw = model ? "" : prismaRawSql(args);
            call = raw
              ? beginDb("prisma", raw)
              : beginDb("prisma", "", {
                  operation,
                  name: model ? `${model}.${operation}` : operation,
                });
          } catch {
            call = undefined;
          }
          try {
            const result = await query(args);
            finishDb(call, undefined);
            return result;
          } catch (error) {
            finishDb(call, error ?? new Error("query failed"));
            throw error;
          }
        },
      },
    }) as T;
  } catch {
    return prisma;
  }
}

/** `require` resolving from the app's working directory, when there is one. */
function appRequire(): ((id: string) => unknown) | undefined {
  const mod = builtin<typeof nodeModule>("module");
  const path = builtin<typeof nodePath>("path");
  const cwd = processObject()?.cwd?.();
  if (!mod?.createRequire || !path || !cwd) {
    return undefined;
  }
  return mod.createRequire(path.join(cwd, "noop.js"));
}

function tryLoad(load: ((id: string) => unknown) | undefined, id: string): unknown {
  if (!load) {
    return undefined;
  }
  try {
    return load(id);
  } catch {
    return undefined;
  }
}

let databasesInstrumented = false;

/**
 * Trace `pg` and `mysql2` statements when the app has them installed
 * (resolved from the working directory). Idempotent; never throws. Prisma
 * needs `instrumentPrisma(prisma)` since it has no shared prototype.
 */
export function instrumentDatabases(): void {
  if (databasesInstrumented) {
    return;
  }
  databasesInstrumented = true;
  try {
    const load = appRequire();
    instrumentPg(tryLoad(load, "pg"));
    instrumentMysql2(tryLoad(load, "mysql2"));
  } catch {
    // Leave databases untraced rather than fail.
  }
}
