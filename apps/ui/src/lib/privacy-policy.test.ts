import { describe, expect, it } from "vitest";
import type { PrivacyPolicy } from "./identity";
import {
  MAX_PATTERNS,
  SAMPLE,
  checkDraft,
  checkLists,
  defaultsOf,
  headerLinesToJSON,
  listsOf,
  patternError,
  privacyError,
  privacyPath,
  rowOfDetail,
  sameLists,
  testSample,
  validLists,
} from "./privacy-policy";
import { BUILT_IN_DEFAULTS, compileRedactor } from "./privacy-redact";

const empty = { mask_query_params: [], mask_headers: [], mask_body_fields: [] };

describe("patternError", () => {
  it("accepts ordinary patterns", () => {
    for (const p of ["^session$", "sig(nature)?", "x-tenant-.*", "card[_-]?no", "\\d+_id", "a\\(b"]) expect(patternError(p)).toBeNull();
  });

  it("blocks an invalid regex with a message", () => {
    expect(patternError("(unclosed")).toMatch(/isn’t a valid regular expression/);
    expect(patternError("[a-")).toMatch(/isn’t a valid regular expression/);
    expect(patternError("*x")).toMatch(/isn’t a valid regular expression/);
  });

  it("blocks what RE2 refuses", () => {
    expect(patternError("token(?=x)")).toMatch(/Lookarounds/);
    expect(patternError("(?<!a)b")).toMatch(/Lookarounds/);
    expect(patternError("(a)\\1")).toMatch(/Backreferences/);
    // An escaped parenthesis or backslash is not one.
    expect(patternError("\\(?=")).toBeNull();
    expect(patternError("a\\\\1")).toBeNull();
  });

  it("limits length in UTF-8 bytes", () => {
    expect(patternError("a".repeat(256))).toBeNull();
    expect(patternError("a".repeat(257))).toMatch(/256 bytes/);
    expect(patternError("é".repeat(129))).toMatch(/256 bytes/);
  });
});

describe("checkDraft", () => {
  it("trims and drops blank rows", () => {
    expect(checkDraft({ mask_query_params: [" a ", "", "  "], mask_headers: ["b"], mask_body_fields: [] })).toEqual({
      ok: true,
      policy: { mask_query_params: ["a"], mask_headers: ["b"], mask_body_fields: [] },
    });
  });

  it("names each bad row by index", () => {
    const r = checkDraft({ mask_query_params: ["ok", "(", "ok"], mask_headers: [], mask_body_fields: ["", "[x"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors.mask_query_params ?? {})).toEqual(["1", "2"]);
    expect(r.errors.mask_query_params?.[2]).toBe("Already in this list.");
    expect(Object.keys(r.errors.mask_body_fields ?? {})).toEqual(["1"]);
    expect(r.errors.mask_headers).toBeUndefined();
  });

  it("caps each list", () => {
    const rows = Array.from({ length: MAX_PATTERNS + 1 }, (_, i) => `p${i}`);
    const r = checkDraft({ ...empty, mask_headers: rows });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.mask_headers?.[MAX_PATTERNS]).toMatch(/At most 50/);
  });
});

describe("checkLists", () => {
  it("accepts what the API accepts", () => {
    expect(checkLists({ mask_query_params: ["a"] })).toEqual({ ok: true, policy: { ...empty, mask_query_params: ["a"] } });
  });

  it("refuses bad shapes and bad patterns", () => {
    expect(checkLists({ mask_headers: "a" }).ok).toBe(false);
    expect(checkLists({ mask_headers: [1] }).ok).toBe(false);
    expect(checkLists({ mask_headers: ["("] }).ok).toBe(false);
    expect(checkLists(null)).toEqual({ ok: true, policy: empty });
  });
});

describe("helpers", () => {
  it("privacyPath", () => {
    expect(privacyPath("shop")).toBe("/shop/settings/privacy");
  });

  it("validLists keeps only usable patterns, for the tester", () => {
    expect(validLists({ mask_query_params: ["a", "(", " a ", ""], mask_headers: [], mask_body_fields: ["x(?=y)", "z"] })).toEqual({
      mask_query_params: ["a"],
      mask_headers: [],
      mask_body_fields: ["z"],
    });
  });

  it("sameLists compares in order", () => {
    expect(sameLists({ ...empty, mask_headers: ["a", "b"] }, { ...empty, mask_headers: ["a", "b"] })).toBe(true);
    expect(sameLists({ ...empty, mask_headers: ["a", "b"] }, { ...empty, mask_headers: ["b", "a"] })).toBe(false);
  });

  it("rowOfDetail reads the API's invalid pattern detail", () => {
    expect(rowOfDetail("mask_headers[2]: not a valid RE2 pattern")).toEqual({ key: "mask_headers", index: 2, reason: "not a valid RE2 pattern" });
    expect(rowOfDetail("The project has no app with that slug or id.")).toBeNull();
    expect(rowOfDetail(undefined)).toBeNull();
  });

  it("listsOf and defaultsOf tolerate null lists", () => {
    const p: PrivacyPolicy = {
      app: null,
      mask_query_params: null,
      mask_headers: ["h"],
      mask_body_fields: null,
      defaults: { mask_query_params: ["q"], mask_headers: null, sensitive_headers: ["cookie"], mask_body_fields: null },
      updated_at: null,
    };
    expect(listsOf(p)).toEqual({ ...empty, mask_headers: ["h"] });
    expect(defaultsOf(p)).toEqual({ mask_query_params: ["q"], mask_headers: [], mask_body_fields: [], sensitive_headers: ["cookie"] });
    expect(defaultsOf(null)).toBe(BUILT_IN_DEFAULTS);
  });

  it("privacyError has a sentence for every code", () => {
    expect(privacyError("invalid_request")).toMatch(/highlighted/);
    expect(privacyError("forbidden")).toMatch(/project admin/);
    expect(privacyError("timeout")).toMatch(/couldn’t reach/);
    expect(privacyError("weird")).toMatch(/Something went wrong/);
  });
});

describe("tester", () => {
  it("turns header lines into the JSON object the edge masks", () => {
    expect(headerLinesToJSON("Accept: */*\nX-Key:v")).toBe('{"Accept":"*/*","X-Key":"v"}');
    expect(headerLinesToJSON("not a header line")).toBeNull();
    expect(headerLinesToJSON("")).toBeNull();
  });

  it("masks the sample with the built-ins plus the draft's patterns", () => {
    const r = compileRedactor(BUILT_IN_DEFAULTS, { mask_query_params: ["^session_id$"], mask_headers: ["^x-tenant-"], mask_body_fields: ["^email$"] });
    const out = testSample(r, SAMPLE);
    expect(out.url).toBe("/v1/orders?page=2&api_key=[redacted]&session_id=[redacted]");
    expect(out.headers).toBe("Authorization: [redacted]\nContent-Type: application/json\nX-Tenant-Id: [redacted]");
    expect(out.body).toContain('"email": "[redacted]"');
    expect(out.body).toContain('"card_number": "[redacted]", "cvc": "[redacted]"');
    expect(out.body).toContain('"sku": "A-1", "qty": 2');
  });

  it("masks JSON headers and free text as the edge does", () => {
    const r = compileRedactor(BUILT_IN_DEFAULTS);
    expect(testSample(r, { url: "", headers: '{"cookie":"a"}', body: "token=abc" })).toEqual({ url: "", headers: '{"cookie":"[redacted]"}', body: "token=[redacted]" });
    expect(testSample(r, { url: "", headers: "garbage line", body: "" }).headers).toBe("garbage line");
  });
});
