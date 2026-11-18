import { describe, expect, it } from "vitest";
import { RELEASE_ENV_SNIPPET, integrationsHref, pickReleaseSdks, releaseSnippets, sdkSetupReleaseHref } from "./release-setup";

describe("pickReleaseSdks", () => {
  it("picks the SDKs the apps reported, first reported first", () => {
    expect(pickReleaseSdks(["spring-boot", "fastapi", "express", "FastAPI"])).toEqual(["spring", "python", "express"]);
  });

  it("falls back to every SDK when none is known", () => {
    expect(pickReleaseSdks([])).toEqual(["python", "express", "spring"]);
    expect(pickReleaseSdks(["", "rails"])).toEqual(["python", "express", "spring"]);
  });
});

describe("releaseSnippets", () => {
  it("sets the release and commit from GIT_SHA with each SDK's own option names", () => {
    expect(releaseSnippets("python")[0].code).toContain('release=os.environ.get("GIT_SHA", "")');
    expect(releaseSnippets("python")[0].code).toContain('commit=os.environ.get("GIT_SHA", "")');
    expect(releaseSnippets("express")[0].code).toContain("release: process.env.GIT_SHA");
    expect(releaseSnippets("express")[0].code).toContain("commit: process.env.GIT_SHA");
    expect(releaseSnippets("spring")[0].code).toContain("apilens.release=${GIT_SHA:}");
    expect(releaseSnippets("spring")[0].code).toContain("apilens.commit=${GIT_SHA:}");
  });

  it("ends with the environment variables every SDK reads", () => {
    for (const sdk of ["python", "express", "spring"] as const) {
      expect(releaseSnippets(sdk).at(-1)).toBe(RELEASE_ENV_SNIPPET);
    }
    expect(RELEASE_ENV_SNIPPET.code).toContain("export APILENS_RELEASE=$GIT_SHA");
    expect(RELEASE_ENV_SNIPPET.code).toContain("export APILENS_COMMIT=$GIT_SHA");
  });
});

describe("settings links", () => {
  it("points at SDK setup's release step and Integrations", () => {
    expect(sdkSetupReleaseHref("my api")).toBe("/project/my%20api/settings/sdk#release");
    expect(integrationsHref("shop")).toBe("/project/shop/settings/integrations");
  });
});
