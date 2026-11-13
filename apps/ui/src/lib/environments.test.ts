import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_COLORS,
  ENVIRONMENT_COLOR_LABELS,
  MAX_ENVIRONMENTS,
  environmentError,
  inOrder,
  isEnvironmentColor,
  moveEnvironment,
  newEnvironmentError,
  removeBlocker,
  keysText,
  lastSeenText,
  sourceLabel,
  stepEnvironment,
  usedText,
  visibleEnvironments,
} from "./environments";

const env = (name: string, position: number, hidden = false) => ({ name, position, hidden });

describe("palette", () => {
  it("is the API's eight colours, each labelled", () => {
    expect(ENVIRONMENT_COLORS).toEqual(["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"]);
    expect(Object.keys(ENVIRONMENT_COLOR_LABELS)).toEqual([...ENVIRONMENT_COLORS]);
    expect(isEnvironmentColor("teal")).toBe(true);
    expect(isEnvironmentColor("none")).toBe(false);
    expect(isEnvironmentColor("#00ff00")).toBe(false);
  });
});

describe("newEnvironmentError", () => {
  const existing = [{ name: "production" }, { name: "staging" }];

  it("accepts a new valid name", () => {
    expect(newEnvironmentError("canary", existing)).toBeNull();
    expect(newEnvironmentError(" qa.eu-1_b ", existing)).toBeNull();
  });

  it("mirrors the API's name rule and limit", () => {
    expect(newEnvironmentError("", existing)).toMatch(/Enter/);
    expect(newEnvironmentError("-qa", existing)).toMatch(/letters, digits/);
    expect(newEnvironmentError("q a", existing)).toMatch(/letters, digits/);
    expect(newEnvironmentError("a".repeat(65), existing)).toMatch(/64/);
    expect(newEnvironmentError("staging", existing)).toBe("This project already has “staging”.");
    const full = Array.from({ length: MAX_ENVIRONMENTS }, (_, i) => ({ name: `env-${i}` }));
    expect(newEnvironmentError("one-more", full)).toMatch(/at most 20/);
    expect(newEnvironmentError("one-more", existing, 2)).toMatch(/at most 2 /);
  });
});

describe("order", () => {
  it("sorts by position, then name, and hides hidden ones from pickers", () => {
    const envs = [env("b", 1), env("a", 1), env("prod", 0), env("old", 2, true)];
    expect(inOrder(envs).map((e) => e.name)).toEqual(["prod", "a", "b", "old"]);
    expect(visibleEnvironments(envs).map((e) => e.name)).toEqual(["prod", "a", "b"]);
  });

  it("moves one name, clamping the index", () => {
    const names = ["production", "staging", "canary", "preview"];
    expect(moveEnvironment(names, "canary", 0)).toEqual(["canary", "production", "staging", "preview"]);
    expect(moveEnvironment(names, "production", 99)).toEqual(["staging", "canary", "preview", "production"]);
    expect(moveEnvironment(names, "staging", -3)).toEqual(["staging", "production", "canary", "preview"]);
    expect(moveEnvironment(names, "missing", 0)).toEqual(names);
  });
});

describe("removeBlocker", () => {
  it("is null for a deletable environment", () => {
    expect(removeBlocker({ deletable: true, has_data: false, api_keys: 0, health_checks: 0 })).toBeNull();
  });

  it("names every reason the API refuses", () => {
    expect(removeBlocker({ deletable: false, has_data: true, api_keys: 2, health_checks: 1 })).toBe(
      "Can’t be removed because it has data, 2 API keys are pinned to it, 1 health check uses it. Hide it instead.",
    );
    expect(removeBlocker({ deletable: false, has_data: false, api_keys: 1, health_checks: 0 })).toBe(
      "Can’t be removed because 1 API key is pinned to it. Hide it instead.",
    );
    expect(removeBlocker({ deletable: false, has_data: false, api_keys: 0, health_checks: 0 })).toMatch(/in use/);
  });
});

describe("copy", () => {
  it("labels the source", () => {
    expect(sourceLabel("sdk")).toBe("Reported by the SDK");
    expect(sourceLabel("dashboard")).toBe("Added here");
  });

  it("has a sentence for each code the operations answer", () => {
    for (const code of ["invalid_request", "environment_in_use", "not_found", "forbidden", "unavailable"]) {
      expect(environmentError(code)).not.toBe(environmentError("other"));
    }
    expect(environmentError("environment_in_use")).toMatch(/Hide it instead/);
  });
});

describe("stepEnvironment", () => {
  // a, (b hidden), c, d
  const envs = [env("a", 0), env("b", 1, true), env("c", 2), env("d", 3)];

  it("swaps with the visible neighbour, leaving hidden ones in place", () => {
    expect(stepEnvironment(envs, "c", -1)).toEqual(["c", "a", "b", "d"]);
    expect(stepEnvironment(envs, "a", 1)).toEqual(["b", "c", "a", "d"]);
    expect(stepEnvironment(envs, "c", 1)).toEqual(["a", "b", "d", "c"]);
  });

  it("is null at the ends and for unknown or hidden names", () => {
    expect(stepEnvironment(envs, "a", -1)).toBeNull();
    expect(stepEnvironment(envs, "d", 1)).toBeNull();
    expect(stepEnvironment(envs, "b", 1)).toBeNull();
    expect(stepEnvironment(envs, "zzz", 1)).toBeNull();
  });
});

describe("keysText and usedText", () => {
  it("count in words", () => {
    expect(keysText(0)).toBe("No keys limited to it");
    expect(keysText(1)).toBe("1 key limited to it");
    expect(keysText(3)).toBe("3 keys limited to it");
    expect(usedText(5, 20)).toBe("5 of 20 environments used");
  });

  it("says when data last arrived", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(lastSeenText(null, now)).toBe("No data yet");
    expect(lastSeenText("2026-11-13T11:59:30Z", now)).toBe("Last seen just now");
    expect(lastSeenText("2026-11-13T09:00:00Z", now)).toBe("Last seen 3 hours ago");
    expect(lastSeenText("2026-11-12T10:00:00Z", now)).toBe("Last seen yesterday");
  });
});
