import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILT_IN_DEFAULTS, type PatternLists, compileRedactor } from "./privacy-redact";

// The contract with the ingest edge: the vectors the Go redactor is checked against
// (internal/controlplane/privacy/redact_vectors_test.go). Wants are Go's output; this port must
// produce the same bytes for every one.
interface Vector {
  name: string;
  policy: PatternLists;
  op: "raw_path" | "headers" | "body" | "text";
  in: string;
  want: string;
}

const vectors = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../../internal/controlplane/privacy/testdata/redact_vectors.json", import.meta.url)), "utf8"),
  ) as { vectors: Vector[] }
).vectors;

describe("redactor port matches the Go edge redactor", () => {
  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThan(20);
  });

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_, v) => {
    const r = compileRedactor(BUILT_IN_DEFAULTS, v.policy);
    const run = { raw_path: r.rawPath, headers: r.headers, body: r.body, text: r.text }[v.op];
    expect(run(v.in)).toBe(v.want);
  });
});

describe("built-in defaults", () => {
  it("are the edge's (internal/controlplane/privacy/redact.go)", () => {
    const go = readFileSync(fileURLToPath(new URL("../../../../internal/controlplane/privacy/redact.go", import.meta.url)), "utf8");
    const list = (name: string) => {
      const m = new RegExp(`${name}\\s*=\\s*\\[\\]string\\{([^}]*)\\}`).exec(go);
      return [...(m?.[1] ?? "").matchAll(/[`"]([^`"]*)[`"]/g)].map((x) => x[1]);
    };
    expect(list("DefaultQueryParams")).toEqual(BUILT_IN_DEFAULTS.mask_query_params);
    expect(list("DefaultHeaders")).toEqual(BUILT_IN_DEFAULTS.mask_headers);
    expect(list("DefaultBodyFields")).toEqual(BUILT_IN_DEFAULTS.mask_body_fields);
    expect(list("SensitiveHeaders")).toEqual(BUILT_IN_DEFAULTS.sensitive_headers);
  });

  it("apply with an empty policy", () => {
    const r = compileRedactor(BUILT_IN_DEFAULTS);
    expect(r.rawPath("/a?token=x&page=1")).toBe("/a?token=[redacted]&page=1");
    expect(r.headerMatches("Set-Cookie")).toBe(true);
    expect(r.headerMatches("content-type")).toBe(false);
  });
});
