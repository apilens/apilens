import { describe, expect, it } from "vitest";
import { KEY_PLACEHOLDER, snippetsFor } from "./install";
import { SDK_LANGUAGES, lastDataLine, reportedSdk, sdkDocs, setupSnippets } from "./sdk-setup";

const INGEST = "https://ingest.example.com";

describe("SDK_LANGUAGES", () => {
  it("lists the languages with an APILens SDK, in onboarding's order", () => {
    expect(SDK_LANGUAGES.map((l) => l.id)).toEqual(["python", "node", "java"]);
  });
});

describe("setupSnippets", () => {
  it("is onboarding's SDK snippets with the key placeholder and the project slug as app name", () => {
    for (const l of SDK_LANGUAGES) {
      const got = setupSnippets(l.id, "shop", INGEST);
      expect(got).toEqual(snippetsFor({ language: l.id, method: "sdk", appId: "shop", ingestUrl: INGEST, posture: "metadata" }));
      expect(got.length).toBeGreaterThan(0);
      const all = got.map((s) => s.code).join("\n");
      expect(all).toContain(`export APILENS_API_KEY=${KEY_PLACEHOLDER}`);
      expect(all).toContain(`${INGEST}/v1`);
      expect(all).toContain("shop");
    }
  });

  it("is empty for a language without an SDK", () => {
    expect(setupSnippets("go", "shop", INGEST)).toEqual([]);
  });
});

describe("sdkDocs", () => {
  it("points each SDK at its setup guide", () => {
    expect(sdkDocs("https://apilens.ai/docs/", "python")).toEqual({ href: "https://apilens.ai/docs/setup-guides/fastapi", framework: "FastAPI" });
    expect(sdkDocs("https://apilens.ai/docs", "node")?.href).toBe("https://apilens.ai/docs/setup-guides/express");
    expect(sdkDocs("https://apilens.ai/docs", "java")?.href).toBe("https://apilens.ai/docs/setup-guides/spring-mvc");
    expect(sdkDocs("https://apilens.ai/docs", "go")).toBeUndefined();
  });
});

describe("reportedSdk", () => {
  it("joins what the SDK reported, or says it is unknown", () => {
    expect(reportedSdk({ framework: "fastapi", framework_version: "0.115", runtime_version: "Python 3.13", sdk_version: "0.4.0" })).toBe(
      "fastapi 0.115 · Python 3.13 · SDK 0.4.0",
    );
    expect(reportedSdk({ framework: "", framework_version: "", runtime_version: "", sdk_version: "" })).toBe("Unknown SDK");
  });
});

describe("lastDataLine", () => {
  const ago = () => "2m ago";
  it("says when data last arrived, that none has, or that it could not check", () => {
    expect(lastDataLine({ received: true, first_at: "x", last_at: "2026-11-13T10:00:00Z", count_1h: 3 }, ago)).toBe("Last data received 2m ago.");
    expect(lastDataLine({ received: false, first_at: null, last_at: null, count_1h: 0 }, ago)).toBe("No data received yet.");
    expect(lastDataLine(null, ago)).toMatch(/^Couldn’t check/);
  });
});
