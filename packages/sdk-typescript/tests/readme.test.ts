/**
 * README parity with the Python SDK: the configuration tables document the
 * same option set as `packages/sdk-python/README.md`, with names camelCased.
 * Options the JS SDK does not have are kept as rows marked "Not in the JS
 * SDK", so a new Python option fails this test until it is documented here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENV_OPTIONS, envVar } from "../src/env.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsReadme = readFileSync(join(here, "..", "README.md"), "utf8");
const pyReadme = readFileSync(join(here, "..", "..", "sdk-python", "README.md"), "utf8");
const typesSource = ["types.ts", "hono.ts"]
  .map((file) => readFileSync(join(here, "..", "src", file), "utf8"))
  .join("\n");

const NOT_IN_JS = "Not in the JS SDK";

/**
 * Python names whose JS spelling is not the plain camelCase: durations carry
 * an `Ms` suffix (they are milliseconds), and two endpoints / modes are named
 * after what they are in this SDK.
 */
const RENAMED: Record<string, string> = {
  flush_interval: "flushIntervalMs",
  timeout: "timeoutMs",
  heartbeat_interval: "heartbeatIntervalMs",
  retry_backoff_base: "retryBackoffBaseMs",
  retry_backoff_max: "retryBackoffMaxMs",
  shutdown_timeout: "shutdownTimeoutMs",
  spans_path: "tracesPath",
  mode: "flushMode",
};

function camel(name: string): string {
  return RENAMED[name] ?? name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

type Row = { names: string[]; cells: string[]; text: string };

/** The rows of the first table after the `heading` line. */
function table(markdown: string, heading: string): Row[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  expect(start, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const rows: Row[] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("|")) {
      inTable = true;
      const cells = line.split("|").slice(1, -1);
      const names = [...(cells[0] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      if (names.length > 0) {
        rows.push({ names, cells, text: line });
      }
    } else if (inTable) {
      break;
    } else if (line.startsWith("#")) {
      break;
    }
  }
  expect(rows.length, `rows under ${heading}`).toBeGreaterThan(0);
  return rows;
}

/** `requestLogging.captureHeaders` → `captureHeaders`. */
function optionName(name: string): string {
  return name.replace(/^requestLogging\./, "");
}

function names(rows: Row[], map: (name: string) => string = (n) => n): string[] {
  return rows.flatMap((row) => row.names.map(map));
}

describe("README option tables match the Python SDK", () => {
  const pairs: Array<[string, string]> = [
    ["### `ApiLensConfig`", "### Client options"],
    ["### Middleware options", "### Middleware options"],
  ];

  for (const [pyHeading, tsHeading] of pairs) {
    it(`${tsHeading} lists every Python option, camelCased, in order`, () => {
      const python = names(table(pyReadme, pyHeading), camel);
      const js = names(table(tsReadme, tsHeading), optionName);
      expect(js).toEqual(python);
    });

    it(`${tsHeading}: every option documented as supported exists in the types`, () => {
      for (const row of table(tsReadme, tsHeading)) {
        if (row.text.includes(NOT_IN_JS)) {
          continue;
        }
        for (const name of row.names.map(optionName)) {
          expect(typesSource, `option ${name}`).toMatch(new RegExp(`\\b${name}\\?:`));
        }
      }
    });

    it(`${tsHeading}: options the JS SDK lacks are absent from the types`, () => {
      for (const row of table(tsReadme, tsHeading)) {
        if (!row.text.includes(NOT_IN_JS)) {
          continue;
        }
        for (const name of row.names.map(optionName)) {
          expect(typesSource, `option ${name}`).not.toMatch(new RegExp(`\\b${name}\\?:`));
        }
      }
    });
  }

  it("the environment-variable table lists the Python variables, in order", () => {
    const python = names(table(pyReadme, "### Environment variables")).filter((n) =>
      n.startsWith("APILENS_"),
    );
    const js = names(table(tsReadme, "### Environment variables")).filter((n) =>
      n.startsWith("APILENS_"),
    );
    expect(js).toEqual(python);
  });

  it("every variable the loader reads is documented with its option", () => {
    const rows = table(tsReadme, "### Environment variables");
    for (const { option, key } of ENV_OPTIONS) {
      const row = rows.find((r) => r.names[0] === envVar(option));
      expect(row, envVar(option)).toBeDefined();
      const cell = row?.cells[1] ?? "";
      const options = [...cell.matchAll(/`([^`]+)`/g)].map((m) => optionName(m[1]));
      expect(options, envVar(option)).toContain(key);
    }
  });

  it("variables documented as not read are not in the loader", () => {
    const read = new Set(ENV_OPTIONS.map(({ option }) => envVar(option)));
    for (const row of table(tsReadme, "### Environment variables")) {
      if (row.text.includes("not read by the JS SDK")) {
        expect(read.has(row.names[0]), row.names[0]).toBe(false);
      }
    }
  });
});
