import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  MAX_DB_STATEMENT_CHARS,
  instrumentMysql2,
  instrumentPg,
  instrumentPrisma,
  obfuscateSql,
} from "../src/db.js";
import { cleanAttributes, MAX_SPANS_PER_REQUEST, RequestSpans, type SpanRecorder } from "../src/spans.js";
import { beginRequestTrace, runWithTrace, type ChildSpan } from "../src/trace.js";

/** Run `fn` inside a traced request; returns the child spans it produced. */
async function traced(fn: () => unknown): Promise<ChildSpan[]> {
  const spans: ChildSpan[] = [];
  const ctx = beginRequestTrace(undefined, { childSpan: (span) => spans.push(span) });
  await runWithTrace(ctx, async () => {
    await fn();
  });
  return spans;
}

const SECRET = "hunter2-secret";

describe("obfuscateSql", () => {
  it("replaces string, number and hex literals with ?", () => {
    expect(obfuscateSql(`SELECT * FROM users WHERE email = 'a@example.com' AND id = 42 AND score > 1.5e3`, "postgresql"))
      .toBe("SELECT * FROM users WHERE email = ? AND id = ? AND score > ?");
    expect(obfuscateSql(`INSERT INTO t (a, b) VALUES ('it''s', 0xDEADBEEF)`, "mysql")).toBe("INSERT INTO t (a, b) VALUES (?, ?)");
    expect(obfuscateSql(`SELECT E'a\\'b', $tag$ ${SECRET} $tag$, $$x$$`, "postgresql")).toBe("SELECT ?, ?, ?");
  });

  it("keeps placeholders, identifiers and numbered names", () => {
    expect(obfuscateSql(`SELECT "Col1", t2.x FROM t2 WHERE a = $1 AND b = ? AND c = :name`, "postgresql"))
      .toBe(`SELECT "Col1", t2.x FROM t2 WHERE a = $1 AND b = ? AND c = :name`);
    expect(obfuscateSql("SELECT `c1` FROM t1", "mysql")).toBe("SELECT `c1` FROM t1");
  });

  it("treats double quotes as strings on MySQL only", () => {
    expect(obfuscateSql(`SELECT * FROM t WHERE p = "${SECRET}"`, "mysql")).toBe("SELECT * FROM t WHERE p = ?");
    expect(obfuscateSql(`SELECT "${SECRET}" FROM t`, "postgresql")).toContain(SECRET);
  });

  it("removes comments and unterminated literals, collapses whitespace", () => {
    const out = obfuscateSql(`SELECT 1 -- token ${SECRET}\n /* ${SECRET} */ FROM t WHERE x = '${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).toBe("SELECT ? FROM t WHERE x = ?");
  });

  it("caps the statement at 2 KiB", () => {
    const out = obfuscateSql(`SELECT ${"col, ".repeat(2000)}x FROM t`);
    expect(out.length).toBe(MAX_DB_STATEMENT_CHARS);
    expect(cleanAttributes({ "db.statement": out })["db.statement"]).toHaveLength(MAX_DB_STATEMENT_CHARS);
    expect(cleanAttributes({ other: out }).other).toHaveLength(512);
  });
});

/** A stand-in for `pg`: `Client#query` with callback, config callback or promise. */
function fakePg() {
  class Client {
    calls: unknown[][] = [];
    query(config: unknown, values?: unknown, callback?: unknown): unknown {
      this.calls.push([config, values]);
      const text = typeof config === "string" ? config : (config as { text: string }).text;
      const fail = text.includes("boom");
      const error = fail ? Object.assign(new Error("relation does not exist"), { name: "DatabaseError" }) : null;
      const cb = typeof values === "function" ? values : typeof callback === "function" ? callback
        : (config as { callback?: unknown }).callback;
      if (typeof cb === "function") {
        setImmediate(() => cb(error, fail ? undefined : { rows: [] }));
        return undefined;
      }
      return fail ? Promise.reject(error) : Promise.resolve({ rows: [] });
    }
  }
  return { Client };
}

describe("pg", () => {
  it("records a db span per query with obfuscated SQL, promise and callback alike", async () => {
    const pg = fakePg();
    expect(instrumentPg(pg)).toBe(true);
    expect(instrumentPg(pg)).toBe(true); // idempotent
    const client = new pg.Client();

    const spans = await traced(async () => {
      await client.query(`SELECT * FROM users WHERE token = '${SECRET}' AND id = 7`);
      await new Promise((resolve) => client.query("UPDATE t SET a = $1", [SECRET], resolve));
      await new Promise((resolve) => client.query({ text: "DELETE FROM t WHERE id = 9", callback: resolve }));
      await (client.query("SELECT boom") as Promise<unknown>).catch(() => undefined);
    });

    expect(spans).toHaveLength(4);
    expect(spans.map((s) => s.attributes["db.statement"])).toEqual([
      "SELECT * FROM users WHERE token = ? AND id = ?",
      "UPDATE t SET a = $1",
      "DELETE FROM t WHERE id = ?",
      "SELECT boom",
    ]);
    expect(spans[0]).toMatchObject({
      kind: "db",
      status: "ok",
      name: "SELECT * FROM users WHERE token = ? AND id = ?",
      attributes: { "db.system": "postgresql", "db.operation": "SELECT" },
    });
    expect(spans[1].attributes["db.operation"]).toBe("UPDATE");
    expect(spans[3]).toMatchObject({ status: "error", attributes: { "error.type": "DatabaseError" } });
    expect(JSON.stringify(spans)).not.toContain(SECRET);
    // Bound values reach the driver untouched.
    expect(client.calls[1][1]).toEqual([SECRET]);
  });

  it("leaves queries outside a request untraced", async () => {
    const pg = fakePg();
    instrumentPg(pg);
    await expect(new pg.Client().query("SELECT 1")).resolves.toEqual({ rows: [] });
  });

  it("rethrows a synchronous driver error and records it", async () => {
    class Client {
      query(): never {
        throw new TypeError("bad config");
      }
    }
    instrumentPg({ Client });
    const spans = await traced(() => {
      expect(() => new Client().query()).toThrow("bad config");
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ status: "error", attributes: { "error.type": "TypeError" } });
  });

  it("ignores a module without Client", () => {
    expect(instrumentPg(undefined)).toBe(false);
    expect(instrumentPg({})).toBe(false);
  });
});

/** A stand-in for `mysql2`: `Connection#query`/`execute` returning a Query emitter. */
function fakeMysql2() {
  class Query extends EventEmitter {
    constructor(readonly sql: string, public onResult?: (err: unknown, rows?: unknown) => void) {
      super();
    }
  }
  class Connection {
    run(sql: unknown, values?: unknown, cb?: unknown): Query {
      const query = sql instanceof Query ? sql
        : new Query(String(sql), (typeof values === "function" ? values : cb) as Query["onResult"]);
      const fail = query.sql.includes("boom");
      setImmediate(() => {
        const error = fail ? Object.assign(new Error("ER_NO_SUCH_TABLE"), { name: "QueryError" }) : null;
        if (query.onResult) {
          query.onResult(error, fail ? undefined : []);
        } else if (error) {
          query.emit("error", error);
        }
        query.emit("end");
      });
      return query;
    }
    query(sql: unknown, values?: unknown, cb?: unknown): Query {
      return this.run(sql, values, cb);
    }
    execute(sql: unknown, values?: unknown, cb?: unknown): Query {
      return this.run(sql, values, cb);
    }
  }
  return { Connection, Query };
}

describe("mysql2", () => {
  it("records query and execute with obfuscated SQL", async () => {
    const mysql2 = fakeMysql2();
    expect(instrumentMysql2(mysql2)).toBe(true);
    const conn = new mysql2.Connection();

    const spans = await traced(async () => {
      await new Promise((resolve) => conn.query(`SELECT * FROM users WHERE name = "${SECRET}" AND age = 30`, resolve));
      await new Promise((resolve) => conn.execute("SELECT * FROM t WHERE id = ?", [SECRET], resolve));
      // A pool passes a prepared Query command.
      await new Promise((resolve) => conn.query(new mysql2.Query(`INSERT INTO t VALUES ('${SECRET}')`, resolve)));
      // Event style, no callback.
      await new Promise((resolve) => conn.query("SELECT 1").on("end", resolve));
      await new Promise((resolve) => conn.query("SELECT boom", () => resolve(undefined)));
      await new Promise((resolve) => conn.query("SELECT boom").on("error", () => undefined).on("end", resolve));
    });

    expect(spans.map((s) => s.attributes["db.statement"])).toEqual([
      "SELECT * FROM users WHERE name = ? AND age = ?",
      "SELECT * FROM t WHERE id = ?",
      "INSERT INTO t VALUES (?)",
      "SELECT ?",
      "SELECT boom",
      "SELECT boom",
    ]);
    expect(spans.every((s) => s.kind === "db" && s.attributes["db.system"] === "mysql")).toBe(true);
    expect(spans.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "error", "error"]);
    expect(JSON.stringify(spans)).not.toContain(SECRET);
  });
});

/** A stand-in for a Prisma client with `$extends` and `query.$allOperations`. */
function fakePrisma() {
  type Hook = (op: { model?: string; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }) => Promise<unknown>;
  const make = (hook?: Hook) => {
    const run = (model: string | undefined, operation: string, args: unknown): Promise<unknown> => {
      const query = async (a: unknown): Promise<unknown> => {
        if (JSON.stringify(a ?? "").includes("boom")) {
          throw Object.assign(new Error("P2002"), { name: "PrismaClientKnownRequestError" });
        }
        return [{ id: 1 }];
      };
      return hook ? hook({ model, operation, args, query }) : query(args);
    };
    return {
      user: { findMany: (args?: unknown) => run("User", "findMany", args) },
      $queryRawUnsafe: (sql: string, ...values: unknown[]) => run(undefined, "$queryRawUnsafe", [sql, ...values]),
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
        run(undefined, "$queryRaw", { strings: [...strings], values }),
      $extends(ext: { query: { $allOperations: Hook } }) {
        return make(ext.query.$allOperations);
      },
    };
  };
  return make();
}

describe("Prisma", () => {
  it("records model and raw operations from the extended client", async () => {
    const prisma = instrumentPrisma(fakePrisma());

    const spans = await traced(async () => {
      await prisma.user.findMany({ where: { email: SECRET } });
      await prisma.$queryRawUnsafe(`SELECT * FROM "User" WHERE email = '${SECRET}'`);
      await prisma.$queryRaw`SELECT * FROM "User" WHERE email = ${SECRET} LIMIT 5`;
      await prisma.user.findMany({ where: { email: "boom" } }).catch(() => undefined);
    });

    expect(spans).toHaveLength(4);
    expect(spans[0]).toMatchObject({
      kind: "db",
      name: "User.findMany",
      status: "ok",
      attributes: { "db.system": "prisma", "db.operation": "findMany" },
    });
    expect(spans[0].attributes["db.statement"]).toBeUndefined();
    expect(spans[1].attributes["db.statement"]).toBe(`SELECT * FROM "User" WHERE email = ?`);
    expect(spans[2].attributes["db.statement"]).toBe(`SELECT * FROM "User" WHERE email = ? LIMIT ?`);
    expect(spans[3]).toMatchObject({ status: "error", attributes: { "error.type": "PrismaClientKnownRequestError" } });
    expect(JSON.stringify(spans)).not.toContain(SECRET);
  });

  it("returns a client without $extends unchanged", () => {
    const legacy = { user: {} };
    expect(instrumentPrisma(legacy)).toBe(legacy);
  });
});

describe("per-request span cap", () => {
  const child = (i: number): ChildSpan => ({
    spanId: String(i).padStart(16, "0"),
    name: `SELECT ${i}`,
    kind: "db",
    startedAt: new Date(),
    durationMs: 1,
    status: "ok",
    statusCode: 0,
    attributes: {},
  });

  function setup() {
    const sent: string[] = [];
    const drops: Array<[string, string, number]> = [];
    const recorder = {
      span: (_ctx: unknown, span: { name: string }) => sent.push(span.name),
      client: { reportDrop: (signal: string, reason: string, count: number) => drops.push([signal, reason, count]) },
    } as unknown as SpanRecorder;
    const spans = new RequestSpans(recorder);
    spans.bind(beginRequestTrace(undefined, spans));
    return { sent, drops, spans };
  }

  it("keeps 2,000 spans and counts the rest as span_cap drops", () => {
    expect(MAX_SPANS_PER_REQUEST).toBe(2000);
    const { sent, drops, spans } = setup();
    for (let i = 0; i < 2005; i++) {
      spans.childSpan(child(i));
    }
    expect(drops).toEqual([]);
    spans.finish(true);
    expect(sent).toHaveLength(2000);
    expect(drops).toEqual([["spans", "span_cap", 5]]);
    // Spans after the response still count against the same cap.
    spans.childSpan(child(9999));
    expect(sent).toHaveLength(2000);
    expect(drops).toEqual([["spans", "span_cap", 5], ["spans", "span_cap", 1]]);
  });

  it("does not count spans of a sampled-out request as drops", () => {
    const { sent, drops, spans } = setup();
    for (let i = 0; i < 2100; i++) {
      spans.childSpan(child(i));
    }
    spans.finish(false);
    spans.childSpan(child(1));
    expect(sent).toEqual([]);
    expect(drops).toEqual([]);
  });
});
