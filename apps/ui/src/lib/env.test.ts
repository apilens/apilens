import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env";

const BASE = {
  APILENS_API_URL: "http://apilens:8080/",
  SESSION_SECRET: "s".repeat(32),
  APILENS_PUBLIC_URL: "https://apilens.example.com",
};

describe("parseEnv: APILENS_PUBLIC_API_URL", () => {
  it("defaults to APILENS_API_URL", () => {
    expect(parseEnv(BASE).publicApiUrl).toBe("http://apilens:8080");
    expect(parseEnv({ ...BASE, APILENS_PUBLIC_API_URL: " " }).publicApiUrl).toBe("http://apilens:8080");
  });

  it("is read without its trailing slash", () => {
    expect(parseEnv({ ...BASE, APILENS_PUBLIC_API_URL: "https://api.example.com/" }).publicApiUrl).toBe("https://api.example.com");
  });

  it("must be an http(s) URL", () => {
    expect(() => parseEnv({ ...BASE, APILENS_PUBLIC_API_URL: "javascript:alert(1)" })).toThrow(EnvError);
    expect(() => parseEnv({ ...BASE, APILENS_PUBLIC_API_URL: "api.example.com" })).toThrow(EnvError);
  });
});

describe("parseEnv: APILENS_PUBLIC_INGEST_URL", () => {
  it("defaults to the local edge", () => {
    expect(parseEnv(BASE).publicIngestUrl).toBe("http://localhost:8080");
    expect(parseEnv({ ...BASE, APILENS_PUBLIC_INGEST_URL: " " }).publicIngestUrl).toBe("http://localhost:8080");
  });

  it("is read without its trailing slash", () => {
    expect(parseEnv({ ...BASE, APILENS_PUBLIC_INGEST_URL: "https://ingest.example.com/" }).publicIngestUrl).toBe("https://ingest.example.com");
  });

  it("must be an http(s) URL", () => {
    expect(() => parseEnv({ ...BASE, APILENS_PUBLIC_INGEST_URL: "ftp://ingest.example.com" })).toThrow(EnvError);
  });
});
