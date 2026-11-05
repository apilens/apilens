import { describe, expect, it } from "vitest";
import {
  HISTORY_MAX,
  canDownload,
  exportBody,
  exportDetail,
  exportPoll,
  exportScope,
  exportStatus,
  exportTitle,
  filterText,
  forgetExport,
  historyKey,
  isActive,
  percent,
  readHistory,
  rememberExport,
  withPublicLink,
} from "./explore-export";
import { NO_FILTERS } from "./explore-filters";
import type { RequestExport } from "./identity";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const id = (n: number) => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

const base: RequestExport = {
  id: ID,
  status: "running",
  filter: { range: "1h" },
  from: "2026-11-05T09:00:00Z",
  to: "2026-11-05T10:00:00Z",
  row_limit: 1_000_000,
  total_rows: 10_000,
  rows_written: 4_200,
  progress: 0.42,
  size_bytes: 0,
  error: null,
  created_at: "2026-11-05T09:59:00Z",
  started_at: "2026-11-05T09:59:01Z",
  finished_at: null,
  expires_at: null,
  download_url: null,
  download_url_expires_at: null,
};
const done: RequestExport = {
  ...base,
  status: "completed",
  rows_written: 10_000,
  progress: 1,
  size_bytes: 1_234_000,
  finished_at: "2026-11-05T10:00:00Z",
  expires_at: "2026-11-06T10:00:00Z",
  download_url: `/api/v1/exports/${ID}/download?expires=1&signature=s`,
};

function memory(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) } as Storage;
}

describe("exportBody", () => {
  it("sends the range and only the filters that are on, typed as the API takes them", () => {
    expect(exportBody("6h", { ...NO_FILTERS, env: "production", status: "5xx", latency_min: 250, request_size_max: 0, sampled: "true" })).toEqual({
      range: "6h",
      env: "production",
      status: "5xx",
      request_size_max: 0,
      latency_min: 250,
      sampled: "true",
    });
    expect(exportBody("1h", NO_FILTERS)).toEqual({ range: "1h" });
  });
});

describe("exportScope and filterText", () => {
  it("say what an export covers", () => {
    expect(exportScope("1h", NO_FILTERS)).toBe("the last 1 hour, no filters");
    expect(exportScope("7d", { ...NO_FILTERS, env: "production" })).toBe("the last 7 days, 1 filter on");
    expect(exportScope("24h", { ...NO_FILTERS, env: "p", latency_min: 1, latency_max: 9 })).toBe("the last 24 hours, 2 filters on");
    expect(filterText({ range: "6h" })).toBe("Last 6 hours");
    expect(filterText({ range: "1h", env: "p", latency_min: 1, latency_max: 2 })).toBe("Last 1 hour, 2 filters");
    expect(filterText({ status: "5xx" })).toBe("Last 24 hours, 1 filter");
    expect(filterText(null)).toBe("Last 24 hours");
  });
});

describe("exportStatus", () => {
  it("reads a completed export past its expiry as expired", () => {
    expect(exportStatus(done, NOW)).toBe("completed");
    expect(exportStatus(done, Date.parse("2026-11-06T10:00:00Z"))).toBe("expired");
    expect(exportStatus({ status: "expired", expires_at: null }, NOW)).toBe("expired");
    expect(exportStatus(base, NOW)).toBe("running");
  });

  it("only offers a download while the file lasts", () => {
    expect(canDownload(done, NOW)).toBe(true);
    expect(canDownload(done, Date.parse("2026-11-07T00:00:00Z"))).toBe(false);
    expect(canDownload({ ...done, download_url: null }, NOW)).toBe(false);
    expect(canDownload(base, NOW)).toBe(false);
  });

  it("keeps reading only queued and running exports", () => {
    expect(["queued", "running", "completed", "failed", "cancelled", "expired"].filter((s) => isActive(s as never))).toEqual(["queued", "running"]);
  });
});

describe("toast copy", () => {
  it("shows progress, the file, and failures with what to do", () => {
    expect(percent(base)).toBe(42);
    expect(percent({ progress: 1.4 })).toBe(100);
    expect(percent({ progress: Number.NaN })).toBe(0);
    expect(exportTitle("running")).toBe("Exporting requests");
    expect(exportDetail(base, NOW)).toBe("4,200 of 10,000 rows written.");
    expect(exportDetail({ ...base, total_rows: null, rows_written: 0 }, NOW)).toBe("0 rows written so far.");
    expect(exportDetail({ ...base, status: "queued" }, NOW)).toBe("It starts as soon as a worker is free.");
    expect(exportDetail(done, NOW)).toBe("10,000 rows, 1.2 MB gzip CSV. Downloadable until Nov 6, 10:00 UTC.");
    expect(exportDetail({ ...done, expires_at: "2026-11-05T18:40:00Z" }, NOW)).toBe("10,000 rows, 1.2 MB gzip CSV. Downloadable until 18:40 UTC.");
    expect(exportDetail({ ...base, status: "failed", error: "clickhouse unavailable." }, NOW)).toBe("clickhouse unavailable. Start a new export to try again.");
    expect(exportDetail({ ...base, status: "failed", error: null }, NOW)).toBe("Start a new export to try again.");
    expect(exportDetail({ ...base, status: "cancelled" }, NOW)).toBe("No file was kept.");
    expect(exportTitle(exportStatus(done, Date.parse("2026-11-08T00:00:00Z")))).toBe("Export expired");
    expect(exportDetail(done, Date.parse("2026-11-08T00:00:00Z"))).toMatch(/^Exports can be downloaded for 24 hours\./);
  });
});

describe("withPublicLink", () => {
  it("makes the signed link absolute against the browser-facing API origin", () => {
    expect(withPublicLink(done, "https://api.example.com/").download_url).toBe(`https://api.example.com/api/v1/exports/${ID}/download?expires=1&signature=s`);
    expect(withPublicLink(base, "https://api.example.com")).toBe(base);
  });
});

describe("exportPoll", () => {
  it("reads the Route Handler's answers", () => {
    expect(exportPoll(200, { ok: true, export: done })).toEqual({ kind: "export", export: done });
    expect(exportPoll(404, { ok: false, code: "not_found" })).toEqual({ kind: "gone" });
    expect(exportPoll(401, { ok: false, code: "session_expired", next: "/refresh" })).toEqual({ kind: "expired", next: "/refresh" });
    expect(exportPoll(502, null)).toEqual({ kind: "error", code: "unavailable" });
    expect(exportPoll(200, { ok: true })).toEqual({ kind: "error", code: "network_error" });
  });
});

describe("history", () => {
  it("remembers exports newest first, per project, at most HISTORY_MAX", () => {
    const s = memory();
    for (let i = 0; i < HISTORY_MAX + 2; i++) rememberExport(s, "shop", id(i));
    const list = readHistory(s, "shop");
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0]).toBe(id(HISTORY_MAX + 1));
    expect(rememberExport(s, "shop", id(5))[0]).toBe(id(5));
    expect(readHistory(s, "shop").filter((x) => x === id(5))).toHaveLength(1);
    expect(readHistory(s, "other")).toEqual([]);
    expect(forgetExport(s, "shop", id(5))).not.toContain(id(5));
  });

  it("ignores junk and failing storage", () => {
    const s = memory();
    s.setItem(historyKey("shop"), JSON.stringify(["../x", ID, 7, ID]));
    expect(readHistory(s, "shop")).toEqual([ID]);
    s.setItem(historyKey("shop"), "{not json");
    expect(readHistory(s, "shop")).toEqual([]);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readHistory(broken, "shop")).toEqual([]);
    expect(rememberExport(broken, "shop", ID)).toEqual([ID]);
    expect(readHistory(null, "shop")).toEqual([]);
  });
});
