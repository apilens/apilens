import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTIONS, actionsFor, can, isAction } from "./capabilities";

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

describe("capabilities vocabulary", () => {
  it("matches the table in docs/architecture/identity.md", () => {
    const doc = repoFile("docs/architecture/identity.md");
    const section = doc.slice(doc.indexOf("## Capabilities vocabulary"));
    const rows = [...section.matchAll(/^\| `([a-z_]+\.[a-z_]+)` \| `[a-z]+#[a-z_]+` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...ACTIONS]);
  });

  it("matches usercontext.Vocabulary", () => {
    const src = repoFile("internal/controlplane/usercontext/usercontext.go");
    const consts = Object.fromEntries([...src.matchAll(/(Action\w+)\s*=\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const block = src.slice(src.indexOf("var Vocabulary"));
    const order = [...block.slice(0, block.indexOf("\n}")).matchAll(/\{(Action\w+),/g)].map((m) => consts[m[1]]);
    expect(order).toEqual([...ACTIONS]);
  });
});

describe("can", () => {
  const caps = { web: ["project.read"], checkout: [...ACTIONS], other: ["future.action"] };

  it("allows only listed actions", () => {
    expect(can(caps, "web", "project.read")).toBe(true);
    expect(can(caps, "web", "project.update")).toBe(false);
    expect(can(caps, "checkout", "billing.manage")).toBe(true);
  });

  it("fails closed for unknown projects and missing capabilities", () => {
    expect(can(caps, "missing", "project.read")).toBe(false);
    expect(can(caps, "toString", "project.read")).toBe(false);
    expect(can(null, "web", "project.read")).toBe(false);
    expect(can(undefined, "web", "project.read")).toBe(false);
  });

  it("lists known actions in vocabulary order", () => {
    expect(actionsFor({ web: ["api_keys.create", "project.read", "future.action"] }, "web")).toEqual([
      "project.read",
      "api_keys.create",
    ]);
    expect(actionsFor(caps, "other")).toEqual([]);
  });

  it("recognizes vocabulary actions", () => {
    expect(isAction("members.invite")).toBe(true);
    expect(isAction("future.action")).toBe(false);
  });
});
