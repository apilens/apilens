import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, autoHidden, droppedAt, gridTemplate, isShown, moveColumn, readPrefs, visibleColumns } from "./explore-columns";

const row = (app: string, env: string, consumer = "") => ({ app_id: app, environment: env, consumer_id: consumer, consumer_name: "" });

describe("readPrefs", () => {
  it("keeps known columns, adds missing ones, drops the rest", () => {
    expect(readPrefs({ order: ["path", "nope", "time", "path"], shown: { app: true, bogus: false, env: "yes" } })).toEqual({
      order: ["path", "time", "status", "method", "app", "env", "latency", "consumer", "size"],
      shown: { app: true },
    });
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe("autoHidden and visibleColumns", () => {
  it("hides App and Env with one value, Consumer with none", () => {
    expect([...autoHidden([row("a", "prod"), row("a", "prod")])].sort()).toEqual(["app", "consumer", "env"]);
    expect([...autoHidden([row("a", "prod", "c1"), row("b", "staging")])]).toEqual([]);
    expect([...autoHidden([])]).toEqual([]);
  });

  it("lets the viewer's choice win over hiding itself", () => {
    const auto = new Set(["app"] as const);
    expect(isShown(DEFAULT_PREFS, auto, "app")).toBe(false);
    expect(isShown({ ...DEFAULT_PREFS, shown: { app: true } }, auto, "app")).toBe(true);
    expect(isShown({ ...DEFAULT_PREFS, shown: { latency: false } }, auto, "latency")).toBe(false);
  });

  it("drops columns by width, keeping Time and Path", () => {
    expect(visibleColumns(DEFAULT_PREFS, new Set(), 1200)).toEqual(["time", "status", "method", "path", "app", "env", "latency", "consumer", "size"]);
    expect(visibleColumns(DEFAULT_PREFS, new Set(), 800)).toEqual(["time", "status", "method", "path", "latency", "consumer"]);
    expect(visibleColumns(DEFAULT_PREFS, new Set(), 500)).toEqual(["time", "status", "path", "latency", "consumer"]);
    expect(visibleColumns({ ...DEFAULT_PREFS, shown: { time: false, path: false } }, new Set(), 1200)).toContain("path");
    expect([...droppedAt(0)]).toEqual([]);
  });
});

describe("moveColumn and gridTemplate", () => {
  it("moves a column and builds the tracks", () => {
    expect(moveColumn(["time", "status", "path"], "path", 0)).toEqual(["path", "time", "status"]);
    expect(moveColumn(["time", "status", "path"], "time", 9)).toEqual(["status", "path", "time"]);
    expect(gridTemplate(["time", "path"])).toBe("40px 150px minmax(250px, 1fr)");
  });
});
