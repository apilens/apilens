import { describe, expect, it } from "vitest";
import { classWords, reasonPhrase, statusText } from "./http-status";

describe("reasonPhrase", () => {
  it("names every common code", () => {
    const want: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
      408: "Request Timeout",
      409: "Conflict",
      410: "Gone",
      413: "Content Too Large",
      415: "Unsupported Media Type",
      422: "Unprocessable Content",
      429: "Too Many Requests",
      500: "Internal Server Error",
      501: "Not Implemented",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    };
    for (const [code, words] of Object.entries(want)) expect(reasonPhrase(Number(code))).toBe(words);
  });

  it("answers empty for codes without a phrase", () => {
    expect(reasonPhrase(299)).toBe("");
    expect(reasonPhrase(Number.NaN)).toBe("");
  });
});

describe("statusText", () => {
  it("joins the code and its phrase", () => {
    expect(statusText(404)).toBe("404 Not Found");
    expect(statusText(200)).toBe("200 OK");
    expect(statusText(599)).toBe("599");
  });
});

describe("classWords", () => {
  it("names the classes", () => {
    expect(classWords("4xx")).toBe("Client error");
    expect(classWords("5xx")).toBe("Server error");
    expect(classWords("9xx")).toBe("");
  });
});
