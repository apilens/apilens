import { describe, expect, it } from "vitest";
import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  checkGeneral,
  deleteConfirmed,
  generalDraftOf,
  projectGeneralError,
  renameSlugError,
  restoreDaysLeft,
  restoreWindowLabel,
} from "./project-general";

const current = { name: "Shop", description: "Storefront API" };

describe("checkGeneral", () => {
  it("answers only the fields that changed, trimmed", () => {
    expect(checkGeneral(current, generalDraftOf(current))).toEqual({ ok: true, body: {} });
    expect(checkGeneral(current, { name: " Shop API ", description: "Storefront API" })).toEqual({ ok: true, body: { name: "Shop API" } });
    expect(checkGeneral(current, { name: "Shop", description: "  " })).toEqual({ ok: true, body: { description: "" } });
  });

  it("reports every field that is wrong", () => {
    const r = checkGeneral(current, { name: "  ", description: "x".repeat(PROJECT_DESCRIPTION_MAX + 1) });
    expect(r).toEqual({ ok: false, errors: { name: "Enter a project name.", description: "Use at most 280 characters." } });
    const long = checkGeneral(current, { ...generalDraftOf(current), name: "n".repeat(PROJECT_NAME_MAX + 1) });
    expect(long).toEqual({ ok: false, errors: { name: "Use at most 100 characters." } });
  });

  it("counts characters, not UTF-16 units", () => {
    expect(checkGeneral(current, { ...generalDraftOf(current), name: "🛒".repeat(PROJECT_NAME_MAX) }).ok).toBe(true);
  });
});

describe("rename and delete", () => {
  it("checks the new slug", () => {
    expect(renameSlugError("shop", "shop-api")).toBeNull();
    expect(renameSlugError("shop", "shop")).toMatch(/already/);
    expect(renameSlugError("shop", "")).toMatch(/Enter/);
    expect(renameSlugError("shop", "Shop API")).toMatch(/lower-case/);
    expect(renameSlugError("shop", "-shop")).toMatch(/lower-case/);
    expect(renameSlugError("shop", "a".repeat(64))).toMatch(/63/);
  });

  it("needs the exact slug to delete", () => {
    expect(deleteConfirmed("shop", "shop")).toBe(true);
    expect(deleteConfirmed("Shop", "shop")).toBe(false);
    expect(deleteConfirmed(" shop", "shop")).toBe(false);
  });

  it("counts the days left to restore", () => {
    const now = Date.parse("2026-11-13T10:00:00Z");
    expect(restoreDaysLeft({ purge_after: "2026-11-18T09:00:00Z" }, now)).toBe(5);
    expect(restoreWindowLabel({ purge_after: "2026-11-18T09:00:00Z" }, now)).toBe("Restorable for 5 more days");
    expect(restoreWindowLabel({ purge_after: "2026-11-13T20:00:00Z" }, now)).toBe("Restorable until today");
    expect(restoreWindowLabel({ purge_after: "2026-11-13T09:00:00Z" }, now)).toBe("Purge due");
    expect(restoreDaysLeft({ purge_after: "not a date" }, now)).toBe(0);
  });
});

describe("projectGeneralError", () => {
  it("has a sentence for each code the operations answer", () => {
    for (const code of ["invalid_request", "slug_immutable", "slug_taken", "confirmation_mismatch", "reauth_required", "forbidden", "not_found", "authz_unavailable"]) {
      expect(projectGeneralError(code)).not.toBe(projectGeneralError("something_else"));
    }
    expect(projectGeneralError("forbidden", "danger")).toMatch(/Only project admins can/);
    expect(projectGeneralError("forbidden")).toMatch(/admins and editors/);
    expect(projectGeneralError("invalid_request", "danger")).toMatch(/address/);
    expect(projectGeneralError(undefined)).toMatch(/Something went wrong/);
  });
});
