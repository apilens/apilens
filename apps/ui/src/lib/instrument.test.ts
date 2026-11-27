import { describe, expect, it } from "vitest";
import { LANGUAGES, languageOf } from "./instrument";

describe("languages", () => {
  it("offers the languages with an APILens SDK", () => {
    expect(LANGUAGES.map((l) => l.label)).toEqual(["Python", "Node.js", "Java"]);
    expect(LANGUAGES.every((l) => l.sdk)).toBe(true);
  });

  it("finds a language by id", () => {
    expect(languageOf("java")?.sdk).toBe("ai.apilens:apilens-java-sdk");
    expect(languageOf("go")).toBeUndefined();
    expect(languageOf(undefined)).toBeUndefined();
  });
});
