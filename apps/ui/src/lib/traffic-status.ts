// The Traffic page's status filter as Explore's Level and Status facets work it: a set of terms,
// classes (`4xx`) and codes (`404`), in `?status=` comma-separated. Ticking adds or removes terms;
// a class stands for all its codes, so unticking one code of a ticked class keeps its other codes.
// Pure; see traffic-status.test.ts.

/** The Level rows: each its status classes (success is under 400). */
export const STATUS_LEVELS = [
  { key: "success", label: "Success", cls: "2xx", classes: ["2xx", "3xx"] },
  { key: "warning", label: "Warning", cls: "4xx", classes: ["4xx"] },
  { key: "error", label: "Error", cls: "5xx", classes: ["5xx"] },
] as const;

const isClass = (t: string) => /^[1-5]xx$/.test(t);
const classOf = (code: string) => `${code[0]}xx`;

/** The terms of a `?status=` value, in order, without repeats. */
export function statusTerms(status: string | undefined): string[] {
  return [...new Set((status ?? "").split(",").filter(Boolean))];
}

const join = (terms: readonly string[]) => terms.join(",");

/** Whether a code is in the filter: listed itself, or its class is. */
export function codeOn(status: string | undefined, code: string): boolean {
  const t = statusTerms(status);
  return t.includes(code) || t.includes(classOf(code));
}

/** A level's box: on when all its classes are in, partial when only some of its codes are. */
export function levelState(status: string | undefined, classes: readonly string[]): "on" | "partial" | "off" {
  const t = statusTerms(status);
  if (classes.every((c) => t.includes(c))) return "on";
  if (t.some((x) => classes.includes(isClass(x) ? x : classOf(x)))) return "partial";
  return "off";
}

/** Ticking or unticking a level: all its classes in (its single codes folded into them), or none of it. */
export function toggleLevel(status: string | undefined, classes: readonly string[]): string {
  const rest = statusTerms(status).filter((x) => !classes.includes(isClass(x) ? x : classOf(x)));
  return join(levelState(status, classes) === "on" ? rest : [...rest, ...classes]);
}

/**
 * Ticking or unticking one code. When its class is in, unticking the code keeps the class's other
 * `known` codes (the ones the sidebar lists) instead.
 */
export function toggleCode(status: string | undefined, code: string, known: readonly string[]): string {
  const t = statusTerms(status);
  const cls = classOf(code);
  if (t.includes(cls)) {
    const siblings = known.filter((k) => k !== code && classOf(k) === cls && !t.includes(k));
    return join([...t.filter((x) => x !== cls), ...siblings]);
  }
  return join(t.includes(code) ? t.filter((x) => x !== code) : [...t, code]);
}

/** A status filter in words: `2xx–3xx, 404`. */
export function statusText(status: string | undefined): string {
  const t = statusTerms(status);
  const out: string[] = [];
  if (t.includes("2xx") && t.includes("3xx")) out.push("2xx–3xx");
  for (const x of t) if (!(out[0] === "2xx–3xx" && (x === "2xx" || x === "3xx"))) out.push(x);
  return out.join(", ");
}
