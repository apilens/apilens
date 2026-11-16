import { describe, expect, it } from "vitest";
import { LANGUAGES, RUNTIMES, SDK_METHOD, languageOf, savedInstrument, sdkReason } from "./instrument";
import { onboardingAnswersSchema } from "./onboarding-save";

describe("choices", () => {
  it("offers the languages with an APILens SDK and the four runtimes", () => {
    expect(LANGUAGES.map((l) => l.label)).toEqual(["Python", "Node.js", "Java"]);
    expect(LANGUAGES.every((l) => l.sdk)).toBe(true);
    expect(RUNTIMES.map((r) => r.id)).toEqual(["kubernetes", "docker", "serverless", "laptop"]);
  });

  it("uses ids the onboarding API accepts as answers", () => {
    for (const l of LANGUAGES) expect(onboardingAnswersSchema.safeParse({ language: l.id }).success).toBe(true);
    for (const r of RUNTIMES) expect(onboardingAnswersSchema.safeParse({ runtime: r.id }).success).toBe(true);
    expect(onboardingAnswersSchema.safeParse({ method: SDK_METHOD }).success).toBe(true);
  });

  it("finds a language by id", () => {
    expect(languageOf("java")?.sdk).toBe("ai.apilens:apilens-java-sdk");
    expect(languageOf("go")).toBeUndefined();
    expect(languageOf(undefined)).toBeUndefined();
  });
});

describe("sdkReason", () => {
  it("says why the SDK suits the runtime", () => {
    expect(sdkReason("python", "laptop")).toContain("install the Python SDK");
    expect(sdkReason("node", "serverless")).toContain("Wrap your handler");
    expect(sdkReason("java", "kubernetes")).toContain("One middleware");
    expect(sdkReason(undefined, undefined)).toContain("One middleware");
  });
});

describe("savedInstrument", () => {
  it("keeps saved answers it can still offer", () => {
    expect(savedInstrument({ language: "python", runtime: "docker", method: "sdk" })).toEqual({ language: "python", runtime: "docker" });
  });

  it("drops a language without an SDK and an unknown runtime", () => {
    expect(savedInstrument({ language: "go", runtime: "mainframe", method: "otlp" })).toEqual({ language: undefined, runtime: undefined });
  });

  it("starts empty with no answers", () => {
    expect(savedInstrument({})).toEqual({ language: undefined, runtime: undefined });
  });
});
