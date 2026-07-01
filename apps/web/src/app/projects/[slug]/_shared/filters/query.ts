// Canonical filter (de)serialisation, shared by the URL state, the typed
// input, and the chips. Grammar mirrors apps/api/apps/projects/filters.py:
//
//   field:op:value ; field:op:value ; ...
//
// * value may be comma-separated (OR within a field)
// * a leading "-" on the field negates the predicate
// * the typed input additionally accepts shorthands (>=, >, ~, =, …) which
//   normalise to canonical ops on the way in.

import { FIELD_MAP, OP_LABELS, OP_SHORTHANDS, type Op } from "./schema";

export interface Predicate {
  field: string;
  op: Op;
  values: string[];
  negate?: boolean;
}

const CANONICAL_OPS = new Set<string>(Object.keys(OP_LABELS));

function isOp(s: string): s is Op {
  return CANONICAL_OPS.has(s);
}

function normalizeValues(field: string, values: string[]): string[] {
  const v = values.map((x) => x.trim()).filter(Boolean);
  // Only HTTP methods are canonically upper-case. Everything else (env names,
  // status classes like "2xx", consumer ids, paths) is case-sensitive as
  // stored — upper-casing them breaks value matching against the option list
  // (checkbox state, de-dupe) and the backend equality filter.
  if (field === "method") return v.map((x) => x.toUpperCase());
  return v;
}

function build(rawField: string, op: Op, valueStr: string, negate: boolean): Predicate | null {
  // Field names are case-insensitive: "Status" / "ENV" resolve to canonical.
  const field = rawField.trim().toLowerCase();
  const spec = FIELD_MAP[field];
  if (!spec || !spec.ops.includes(op)) return null;
  const values = normalizeValues(field, valueStr.split(","));
  if (!values.length) return null;
  if (op === "between" && values.length !== 2) return null;
  return { field, op, values, negate: negate || undefined };
}

/** Parse a single token (canonical or typed-shorthand) into a predicate. */
export function parseToken(raw: string): Predicate | null {
  let t = raw.trim();
  if (!t) return null;
  let negate = false;
  if (t.startsWith("-")) {
    negate = true;
    t = t.slice(1).trim();
  }

  const colon = t.indexOf(":");
  if (colon === -1) {
    // shorthand form with no colon, e.g. "status>=500"
    for (const [sh, op] of OP_SHORTHANDS) {
      const i = t.indexOf(sh);
      if (i > 0) return build(t.slice(0, i).trim(), op, t.slice(i + sh.length), negate);
    }
    return null;
  }

  const field = t.slice(0, colon).trim();
  const rest = t.slice(colon + 1);
  const restTrim = rest.trimStart();

  // "field:>=value"
  for (const [sh, op] of OP_SHORTHANDS) {
    if (restTrim.startsWith(sh)) return build(field, op, restTrim.slice(sh.length), negate);
  }

  // "field:op:value" (canonical)
  const c2 = rest.indexOf(":");
  if (c2 !== -1) {
    const opCand = rest.slice(0, c2).trim().toLowerCase();
    if (isOp(opCand)) return build(field, opCand, rest.slice(c2 + 1), negate);
  }

  // "field:value" → default op
  return build(field, "is", rest, negate);
}

export function serializePredicate(p: Predicate): string {
  return `${p.negate ? "-" : ""}${p.field}:${p.op}:${p.values.join(",")}`;
}

export function serializeFilter(preds: Predicate[]): string {
  return preds.map(serializePredicate).join(";");
}

export function parseFilter(raw: string | null | undefined): Predicate[] {
  if (!raw) return [];
  const out: Predicate[] = [];
  for (const chunk of raw.split(";")) {
    const p = parseToken(chunk);
    if (p) out.push(p);
  }
  return out;
}

/** Human-readable pieces for a chip. */
export function describe(p: Predicate): { field: string; op: string; value: string } {
  const spec = FIELD_MAP[p.field];
  const opLabel = p.negate ? `not ${OP_LABELS[p.op]}` : OP_LABELS[p.op];
  const value = p.op === "between" ? p.values.join(" – ") : p.values.join(", ");
  return {
    field: spec?.label ?? p.field,
    op: opLabel,
    value: spec?.unit ? `${value} ${spec.unit}` : value,
  };
}

/** Stable-ish key for React lists (filter strings are short and unique enough). */
export function predicateKey(p: Predicate, idx: number): string {
  return `${idx}:${serializePredicate(p)}`;
}

/** Replace any existing predicate for `field` with a single is-predicate. */
export function upsertSingle(raw: string, field: string, op: Op, value: string): string {
  const preds = parseFilter(raw).filter((p) => p.field !== field);
  preds.push({ field, op, values: [value] });
  return serializeFilter(preds);
}

/**
 * Upsert a whole predicate by field (one predicate per field). Replaces any
 * existing predicate for the same field; removes it if `values` is empty.
 */
export function upsertPredicate(raw: string, p: Predicate): string {
  const preds = parseFilter(raw).filter((x) => x.field !== p.field);
  if (p.values.length) preds.push(p);
  return serializeFilter(preds);
}

/** The current predicate for a field, if any. */
export function predicateFor(raw: string, field: string): Predicate | undefined {
  return parseFilter(raw).find((p) => p.field === field);
}

/** Union `values` into a field's predicate (add-only; never toggles off). */
export function addValues(
  raw: string,
  field: string,
  op: Op,
  values: string[],
  negate?: boolean,
): string {
  const preds = parseFilter(raw);
  const idx = preds.findIndex((p) => p.field === field);
  if (idx === -1) {
    preds.push({ field, op, values: [...new Set(values)], negate: negate || undefined });
  } else {
    const merged = [...new Set([...preds[idx].values, ...values])];
    preds[idx] = { field, op, values: merged, negate: negate || undefined };
  }
  return serializeFilter(preds);
}

/**
 * Toggle a single value within a field's predicate (multi-select). Keeps the
 * given op/negate; creates the predicate if absent; drops it when the last
 * value is removed.
 */
export function toggleValue(
  raw: string,
  field: string,
  op: Op,
  value: string,
  negate?: boolean,
): string {
  const preds = parseFilter(raw);
  const idx = preds.findIndex((p) => p.field === field);
  if (idx === -1) {
    preds.push({ field, op, values: [value], negate: negate || undefined });
  } else {
    const cur = preds[idx];
    const has = cur.values.includes(value);
    const values = has ? cur.values.filter((v) => v !== value) : [...cur.values, value];
    if (values.length === 0) preds.splice(idx, 1);
    else preds[idx] = { field, op, values, negate: negate || undefined };
  }
  return serializeFilter(preds);
}
