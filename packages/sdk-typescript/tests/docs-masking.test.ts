/**
 * The "Worked examples" on the masking docs page are true (issue #613): every
 * row of the `| Where | Sent | Stored |` table in
 * apps/docs/sdk-reference/masking.mdx is run through the SDK's default
 * masking. The Python SDK's tests/test_docs_masking.py checks the same table.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Redactor, serializeHeaders } from "../src/sanitize.js";

const DOCS_PAGE = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/docs/sdk-reference/masking.mdx");
const ROW = /^\| `(query|header|body|form)` \| `([^`]*)` \| `([^`]*)` \|$/;

const rows: Array<[string, string, string]> = existsSync(DOCS_PAGE)
  ? readFileSync(DOCS_PAGE, "utf8")
      .split("\n")
      .map((line) => ROW.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] as string, m[2] as string, m[3] as string])
  : [];

describe.skipIf(!existsSync(DOCS_PAGE))("masking.mdx worked examples", () => {
  it("covers query, header, body and form rows", () => {
    expect(new Set(rows.map(([where]) => where))).toEqual(new Set(["query", "header", "body", "form"]));
  });

  it.each(rows)("%s: %s", (where, sent, stored) => {
    const redactor = new Redactor();
    if (where === "query") {
      expect(redactor.redactQuery(sent)).toBe(stored);
    } else if (where === "form") {
      expect(redactor.redactForm(sent)).toBe(stored);
    } else if (where === "body") {
      expect(JSON.parse(redactor.redactBody(sent))).toEqual(JSON.parse(stored));
    } else {
      const [name, value] = sent.split(": ", 2) as [string, string];
      const [wantName, wantValue] = stored.split(": ", 2) as [string, string];
      expect(JSON.parse(serializeHeaders({ [name]: value }, { redactor }))).toEqual({ [wantName]: wantValue });
    }
  });
});
