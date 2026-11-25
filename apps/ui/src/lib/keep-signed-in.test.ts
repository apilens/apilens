import { describe, expect, it } from "vitest";
import { pathWithRemember, rememberFromParam, withRemember } from "./keep-signed-in";

describe("withRemember", () => {
  it("sets remember on a start URL, keeping its other parameters", () => {
    const href = "https://api.example.com/api/v1/auth/oauth/google/start?next=%2Fx&intent=login&remember=true";
    const url = new URL(withRemember(href, false));
    expect(url.searchParams.get("remember")).toBe("false");
    expect(url.searchParams.get("next")).toBe("/x");
    expect(url.searchParams.get("intent")).toBe("login");
  });

  it("adds remember when the URL has none", () => {
    expect(new URL(withRemember("https://idp.example.com/start", true)).searchParams.get("remember")).toBe("true");
  });

  it("leaves an unparseable href alone", () => {
    expect(withRemember("not a url", false)).toBe("not a url");
  });
});

describe("rememberFromParam", () => {
  it("is false only for 0 or false", () => {
    expect(rememberFromParam("0")).toBe(false);
    expect(rememberFromParam("false")).toBe(false);
    expect(rememberFromParam("1")).toBe(true);
    expect(rememberFromParam(null)).toBe(true);
    expect(rememberFromParam("junk")).toBe(true);
  });
});

describe("pathWithRemember", () => {
  it("marks an unticked box on a relative path, keeping its query", () => {
    expect(pathWithRemember("/verify?flow=signin&email=a%40b.co", false)).toBe("/verify?flow=signin&email=a%40b.co&remember=0");
  });

  it("leaves the path alone when the box is ticked", () => {
    expect(pathWithRemember("/verify?flow=signin", true)).toBe("/verify?flow=signin");
  });
});
