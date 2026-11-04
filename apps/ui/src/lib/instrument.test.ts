import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  METHODS,
  RUNTIMES,
  effectiveMethod,
  languageEnabled,
  methodsFor,
  recommend,
  recommendReason,
  savedInstrument,
} from "./instrument";
import { onboardingAnswersSchema } from "./onboarding-save";

describe("choices", () => {
  it("offers the ten languages and four runtimes of the step", () => {
    expect(LANGUAGES.map((l) => l.label)).toEqual(["Python", "Node.js", "Java", "Go", ".NET", "PHP", "Ruby", "Browser", "iOS", "Android"]);
    expect(RUNTIMES.map((r) => r.id)).toEqual(["kubernetes", "docker", "serverless", "laptop"]);
  });

  it("enables only languages with an SDK or an OTLP path", () => {
    expect(LANGUAGES.filter(languageEnabled).map((l) => l.id)).toEqual(["python", "node", "java", "go", "dotnet", "php", "ruby"]);
  });

  it("uses ids the onboarding API accepts as answers", () => {
    for (const l of LANGUAGES) expect(onboardingAnswersSchema.safeParse({ language: l.id }).success).toBe(true);
    for (const r of RUNTIMES) expect(onboardingAnswersSchema.safeParse({ runtime: r.id }).success).toBe(true);
    for (const m of METHODS) expect(onboardingAnswersSchema.safeParse({ method: m }).success).toBe(true);
  });
});

describe("methodsFor", () => {
  it.each([
    ["python", ["sdk", "otlp"]],
    ["java", ["sdk", "otlp"]],
    ["go", ["otlp"]],
    ["ios", []],
    ["cobol", []],
    [undefined, []],
  ])("%s → %j", (lang, methods) => {
    expect(methodsFor(lang)).toEqual(methods);
  });
});

describe("recommend", () => {
  it("recommends the SDK where there is one, on every runtime", () => {
    for (const r of RUNTIMES) {
      expect(recommend("node", r.id)).toBe("sdk");
      expect(recommend("python", r.id)).toBe("sdk");
    }
  });

  it("recommends OpenTelemetry for languages without an SDK", () => {
    expect(recommend("go", "kubernetes")).toBe("otlp");
    expect(recommend("ruby", "laptop")).toBe("otlp");
  });

  it("recommends nothing for a language with no path", () => {
    expect(recommend("android", "docker")).toBeUndefined();
    expect(recommend(undefined, undefined)).toBeUndefined();
  });

  it("explains the recommendation per runtime", () => {
    expect(recommendReason("sdk", "python", "laptop")).toContain("Python SDK");
    expect(recommendReason("sdk", "node", "serverless")).toContain("no agent or sidecar");
    expect(recommendReason("otlp", "go", "kubernetes")).toContain("Collector");
    expect(recommendReason("otlp", "go", "docker")).toContain("OpenTelemetry SDK for Go");
  });
});

describe("savedInstrument / effectiveMethod", () => {
  it("resumes from the saved answers", () => {
    expect(savedInstrument({ language: "java", runtime: "kubernetes", method: "otlp" })).toEqual({ language: "java", runtime: "kubernetes", method: "otlp" });
  });

  it("drops answers the step can no longer offer", () => {
    expect(savedInstrument({ language: "ios", runtime: "mainframe", method: "sdk" })).toEqual({});
    expect(savedInstrument({ language: "go", method: "sdk" })).toEqual({ language: "go" });
    expect(savedInstrument({ language: "python", method: "url-check" })).toEqual({ language: "python" });
  });

  it("keeps a picked method while the language can use it, else falls back to the recommendation", () => {
    expect(effectiveMethod({ language: "python", runtime: "docker" })).toBe("sdk");
    expect(effectiveMethod({ language: "python", runtime: "docker", method: "otlp" })).toBe("otlp");
    expect(effectiveMethod({ language: "go", runtime: "docker", method: "sdk" })).toBe("otlp");
    expect(effectiveMethod({})).toBeUndefined();
  });
});
