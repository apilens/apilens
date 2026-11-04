import { describe, expect, it } from "vitest";
import { ACCOUNT_SECTIONS, accountSection, accountSectionHref } from "./account-settings";

describe("accountSection", () => {
  it("opens Profile at /settings", () => {
    expect(accountSection(undefined)?.label).toBe("Profile");
    expect(accountSection([])?.label).toBe("Profile");
  });

  it("resolves every known section", () => {
    expect(accountSection(["security"])?.label).toBe("Security");
    expect(accountSection(["sessions"])?.label).toBe("Sessions");
    expect(accountSection(["connected-accounts"])?.label).toBe("Connected accounts");
    expect(accountSection(["danger"])?.label).toBe("Danger zone");
  });

  it("is undefined (404) for unknown or nested sections", () => {
    expect(accountSection(["billing"])).toBeUndefined();
    expect(accountSection(["profile"])).toBeUndefined();
    expect(accountSection([""])).toBeUndefined();
    expect(accountSection(["security", "passkeys"])).toBeUndefined();
  });
});

describe("accountSectionHref", () => {
  it("links each section under /settings", () => {
    expect(ACCOUNT_SECTIONS.map(accountSectionHref)).toEqual(["/settings", "/settings/security", "/settings/sessions", "/settings/connected-accounts", "/settings/danger"]);
  });

  it("round-trips through accountSection", () => {
    for (const s of ACCOUNT_SECTIONS) {
      const segs = accountSectionHref(s).split("/").slice(2);
      expect(accountSection(segs.length ? segs : undefined)).toBe(s);
    }
  });
});
