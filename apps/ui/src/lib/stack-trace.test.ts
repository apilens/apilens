import { describe, expect, it } from "vitest";
import { detectFormat, exceptionLog, frameLocation, parseException, parseJava, parseNode, parsePython, splitHeader } from "./stack-trace";

const PY_CHAIN = `Traceback (most recent call last):
  File "/app/shop/payments.py", line 6, in pay
    charge()
  File "/usr/lib/python3.12/site-packages/stripe/api.py", line 3, in charge
    raise ConnectionError("card gateway timed out")
ConnectionError: card gateway timed out

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/app/shop/orders.py", line 11, in handler
    pay()
  File "/app/shop/payments.py", line 8, in pay
    raise RuntimeError("payment failed") from e
    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
RuntimeError: payment failed

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/app/shop/views.py", line 15, in create_order
    handler()
  File "/app/shop/orders.py", line 13, in handler
    raise ValueError("order 42 rejected")
ValueError: order 42 rejected
`;

const PY_GROUP = `  + Exception Group Traceback (most recent call last):
  |   File "/app/shop/views.py", line 22, in bulk
  |     g()
  |   File "/app/shop/bulk.py", line 20, in g
  |     raise ExceptionGroup("many failures", [ValueError("bad sku"), TypeError("bad qty")])
  | ExceptionGroup: many failures (2 sub-exceptions)
  +-+---------------- 1 ----------------
    | ValueError: bad sku
    +---------------- 2 ----------------
    | TypeError: bad qty
    +------------------------------------
`;

const NODE = `Error: load cart failed
    at load (/app/src/cart.js:2:54)
    at async Router.handle (/app/node_modules/express/lib/router/index.js:284:7)
    at node:internal/main/run_main_module:36:49
Caused by: RangeError: pool exhausted
    at query (/app/src/db.js:1:26)
    at new Pool (/app/node_modules/pg-pool/index.js:45:11)
Aggregated error 1 of 2: TypeError: bad sku
    at check (/app/src/sku.js:9:3)
Aggregated error 2 of 2: Error: bad qty`;

const JAVA = `java.lang.IllegalStateException: order 42 rejected
\tat com.shop.orders.OrderService.create(OrderService.java:42)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)
\tat java.base/java.lang.Thread.run(Thread.java:1583)
\tSuppressed: java.io.IOException: close failed
\t\tat com.shop.db.Conn.close(Conn.java:12)
\t\t... 3 more
Caused by: com.shop.payments.PaymentException: payment failed
\tat com.shop.payments.Gateway.charge(Gateway.java:88)
\t... 2 more
Caused by: java.net.SocketTimeoutException: Read timed out
\tat java.base/sun.nio.ch.NioSocketImpl.timedRead(Native Method)
\t... 5 more
`;

describe("splitHeader", () => {
  it("splits at the first colon and space", () => {
    expect(splitHeader("ValueError: a: b")).toEqual({ type: "ValueError", message: "a: b" });
    expect(splitHeader("KeyboardInterrupt")).toEqual({ type: "KeyboardInterrupt", message: "" });
  });
});

describe("parsePython", () => {
  it("shows the raised exception first, then its context and its cause", () => {
    const blocks = parsePython(PY_CHAIN);
    expect(blocks.map((b) => [b.label, b.type, b.message])).toEqual([
      ["Raised", "ValueError", "order 42 rejected"],
      ["While handling", "RuntimeError", "payment failed"],
      ["Caused by", "ConnectionError", "card gateway timed out"],
    ]);
    expect(blocks.map((b) => b.relation)).toEqual(["raised", "context", "cause"]);
    const [frame] = blocks[0].frames;
    expect(frame).toEqual({ fn: "create_order", file: "/app/shop/views.py", line: 15, code: "handler()", inApp: true });
    // The caret line is skipped, not a frame.
    expect(blocks[1].frames).toHaveLength(2);
    expect(blocks[2].frames.map((f) => f.inApp)).toEqual([true, false]);
  });

  it("parses ExceptionGroup members as their own blocks", () => {
    const blocks = parsePython(PY_GROUP);
    expect(blocks.map((b) => [b.label, b.type, b.message])).toEqual([
      ["Raised", "ExceptionGroup", "many failures (2 sub-exceptions)"],
      ["Sub-exception 1", "ValueError", "bad sku"],
      ["Sub-exception 2", "TypeError", "bad qty"],
    ]);
    expect(blocks[0].frames.map((f) => [f.file, f.line, f.code])).toEqual([
      ["/app/shop/views.py", 22, "g()"],
      ["/app/shop/bulk.py", 20, 'raise ExceptionGroup("many failures", [ValueError("bad sku"), TypeError("bad qty")])'],
    ]);
  });
});

describe("parseNode", () => {
  it("parses the stack, every Caused by and every aggregated member", () => {
    const blocks = parseNode(NODE);
    expect(blocks.map((b) => [b.relation, b.label, b.type, b.message])).toEqual([
      ["raised", "Raised", "Error", "load cart failed"],
      ["cause", "Caused by", "RangeError", "pool exhausted"],
      ["member", "Aggregated error 1 of 2", "TypeError", "bad sku"],
      ["member", "Aggregated error 2 of 2", "Error", "bad qty"],
    ]);
    expect(blocks[0].frames).toEqual([
      { fn: "load", file: "/app/src/cart.js", line: 2, code: "", inApp: true },
      { fn: "Router.handle", file: "/app/node_modules/express/lib/router/index.js", line: 284, code: "", inApp: false },
      { fn: "", file: "node:internal/main/run_main_module", line: 36, code: "", inApp: false },
    ]);
    expect(blocks[1].frames.map((f) => f.fn)).toEqual(["query", "Pool"]);
  });
});

describe("parseJava", () => {
  it("parses the throwable, Suppressed and every Caused by", () => {
    const blocks = parseJava(JAVA);
    expect(blocks.map((b) => [b.relation, b.type, b.message])).toEqual([
      ["raised", "java.lang.IllegalStateException", "order 42 rejected"],
      ["suppressed", "java.io.IOException", "close failed"],
      ["cause", "com.shop.payments.PaymentException", "payment failed"],
      ["cause", "java.net.SocketTimeoutException", "Read timed out"],
    ]);
    expect(blocks[0].frames).toEqual([
      { fn: "com.shop.orders.OrderService.create", file: "OrderService.java", line: 42, code: "", inApp: true },
      { fn: "org.springframework.web.servlet.FrameworkServlet.service", file: "FrameworkServlet.java", line: 897, code: "", inApp: false },
      { fn: "java.lang.Thread.run", file: "Thread.java", line: 1583, code: "", inApp: false },
    ]);
    expect(blocks[1].frames.map((f) => f.note ?? f.fn)).toEqual(["com.shop.db.Conn.close", "... 3 more"]);
    expect(blocks[3].frames[0]).toMatchObject({ fn: "sun.nio.ch.NioSocketImpl.timedRead", file: "Native Method", line: null, inApp: false });
  });
});

describe("parseException", () => {
  it("detects each runtime", () => {
    expect(detectFormat(PY_CHAIN)).toBe("python");
    expect(detectFormat(PY_GROUP)).toBe("python");
    expect(detectFormat(NODE)).toBe("node");
    expect(detectFormat(JAVA)).toBe("java");
    expect(detectFormat("boom")).toBe("raw");
  });

  it("lifts out the truncation marker and still parses head and tail", () => {
    const cut = PY_CHAIN.replace("During handling", "Dur\n…[123456 chars truncated]…\nduring handling");
    const parsed = parseException(cut);
    expect(parsed.truncated).toBe(123456);
    expect(parsed.format).toBe("python");
    expect(parsed.blocks[0].type).toBe("ValueError");
    expect(parsed.blocks.at(-1)?.type).toBe("ConnectionError");
  });

  it("falls back to raw text when nothing parses as frames", () => {
    expect(parseException("panic: something odd\ngoroutine 1 [running]:")).toEqual({ format: "raw", blocks: [], truncated: null });
    expect(parseException("x\n…[9 chars truncated]…\ny").truncated).toBe(9);
  });

  it("picks the apilens.exception log with a payload", () => {
    const logs = [
      { logger_name: "app", payload: "x" },
      { logger_name: "apilens.exception", payload: "" },
      { logger_name: "apilens.exception", payload: "Traceback" },
    ];
    expect(exceptionLog(logs)).toBe(logs[2]);
    expect(exceptionLog([logs[1]])).toBe(logs[1]);
    expect(exceptionLog([logs[0]])).toBeNull();
  });

  it("formats a frame location", () => {
    expect(frameLocation({ fn: "pay", file: "a.py", line: 3, code: "", inApp: true })).toBe("a.py:3 in pay");
    expect(frameLocation({ fn: "", file: "node:x", line: null, code: "", inApp: false })).toBe("node:x");
  });
});
