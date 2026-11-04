import { describe, expect, it } from "vitest";
import { SAFE_NEXT_MAX_LENGTH, safeNext } from "./safe-next";

const FALLBACK = "/fallback";

describe("safeNext", () => {
  const accepted: string[] = [
    "/",
    "/projects",
    "/projects/acme/traffic?range=24h#top",
    "/invite/abc123",
    "/search?q=a b",
    "/path/with//double/inside",
    "/redirect?to=https://evil.com",
    `/${"a".repeat(SAFE_NEXT_MAX_LENGTH - 1)}`,
  ];

  it.each(accepted)("accepts %j", (input) => {
    expect(safeNext(input, FALLBACK)).toBe(input);
  });

  const rejected: [string, unknown][] = [
    ["protocol-relative", "//evil.com"],
    ["protocol-relative with path", "//evil.com/projects"],
    ["triple slash", "///evil.com"],
    ["slash-backslash", "/\\evil.com"],
    ["backslash-slash", "\\/evil.com"],
    ["double backslash", "\\\\evil.com"],
    ["backslash later in path", "/projects\\..\\evil"],
    ["javascript scheme", "javascript:alert(1)"],
    ["javascript scheme, mixed case", "JaVaScRiPt:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["absolute https URL", "https://evil.com"],
    ["absolute http URL", "http://evil.com/projects"],
    ["scheme-relative without slashes", "https:evil.com"],
    ["bare host", "evil.com"],
    ["relative path", "projects"],
    ["dot-relative path", "./projects"],
    ["leading whitespace", " /projects"],
    ["tab between slashes", "/\t/evil.com"],
    ["newline between slashes", "/\n/evil.com"],
    ["carriage return", "/\r/evil.com"],
    ["null byte", "/projects\u0000"],
    ["DEL character", "/projects\u007f"],
    ["empty string", ""],
    ["over the length limit", `/${"a".repeat(SAFE_NEXT_MAX_LENGTH)}`],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["array", ["/projects"]],
    ["object", { pathname: "/projects" }],
  ];

  it.each(rejected)("rejects %s", (_name, input) => {
    expect(safeNext(input, FALLBACK)).toBe(FALLBACK);
  });

  it("defaults the fallback to /", () => {
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });

  it("keeps the result on the current origin when resolved as a URL", () => {
    const base = "https://app.apilens.ai";
    for (const input of [...accepted, ...rejected.map(([, v]) => v)]) {
      expect(new URL(safeNext(input, FALLBACK), base).origin).toBe(base);
    }
  });
});
