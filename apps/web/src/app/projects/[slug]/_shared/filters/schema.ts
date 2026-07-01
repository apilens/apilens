// Field registry for the unified rich-filter bar.
//
// This is the frontend half of the contract implemented on the backend at
// apps/api/apps/projects/filters.py — keep the two in lock-step (same fields,
// same operators, same canonical tokens).
//
// App scope and time range are intentionally NOT here — they keep their own
// dedicated controls (AppFilter + TimeRangePicker).

export type FieldType = "enum" | "int" | "string";

// Canonical operator tokens (what the URL / backend see).
export type Op =
  | "is"
  | "not"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "startswith"
  | "endswith";

export interface OpSpec {
  op: Op;
  label: string; // shown in the chip / operator menu
}

export interface FieldSpec {
  field: string;
  label: string;
  type: FieldType;
  ops: Op[];
  values?: string[]; // static enum values (restricted)
  suggest?: string[]; // non-restricting autocomplete hints (e.g. common status codes)
  // Dynamic value source key — the FilterBar loads options for these.
  valueSource?: "env" | "consumer" | "app";
  unit?: string; // e.g. "ms", "bytes" — display hint
  placeholder?: string;
}

export const OP_LABELS: Record<Op, string> = {
  is: "is",
  not: "is not",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  contains: "contains",
  startswith: "starts with",
  endswith: "ends with",
};

const SET_OPS: Op[] = ["is", "not"];
const NUM_OPS: Op[] = ["is", "not", "gt", "gte", "lt", "lte", "between"];
const STR_OPS: Op[] = ["is", "not", "contains", "startswith", "endswith"];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
export const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"];

export const COMMON_STATUS_CODES = [
  "200", "201", "202", "204", "301", "302", "304",
  "400", "401", "403", "404", "409", "422", "429",
  "500", "502", "503", "504",
];

export const FIELDS: FieldSpec[] = [
  { field: "app", label: "App", type: "string", ops: SET_OPS, valueSource: "app" },
  { field: "method", label: "Method", type: "enum", ops: SET_OPS, values: HTTP_METHODS },
  { field: "status", label: "Status code", type: "int", ops: NUM_OPS, suggest: COMMON_STATUS_CODES, placeholder: "404" },
  { field: "status_class", label: "Status class", type: "enum", ops: SET_OPS, values: STATUS_CLASSES },
  { field: "path", label: "Path", type: "string", ops: STR_OPS, placeholder: "/v1/orders" },
  { field: "latency", label: "Latency", type: "int", ops: ["gt", "gte", "lt", "lte", "between"], unit: "ms", placeholder: "200" },
  { field: "env", label: "Environment", type: "enum", ops: SET_OPS, valueSource: "env" },
  { field: "consumer", label: "Consumer", type: "string", ops: ["is", "not", "contains"], valueSource: "consumer", placeholder: "user@example.com" },
  { field: "req_size", label: "Request size", type: "int", ops: ["gt", "gte", "lt", "lte", "between"], unit: "bytes", placeholder: "1024" },
  { field: "resp_size", label: "Response size", type: "int", ops: ["gt", "gte", "lt", "lte", "between"], unit: "bytes", placeholder: "1024" },
  { field: "ip", label: "IP address", type: "string", ops: ["is", "not", "contains"], placeholder: "1.2.3.4" },
  { field: "ua", label: "User agent", type: "string", ops: ["contains"], placeholder: "Mozilla" },
];

export const FIELD_MAP: Record<string, FieldSpec> = Object.fromEntries(
  FIELDS.map((f) => [f.field, f]),
);

// Typed-input shorthands → canonical op. Longest first so ">=" beats ">".
export const OP_SHORTHANDS: Array<[string, Op]> = [
  [">=", "gte"],
  ["<=", "lte"],
  ["!=", "not"],
  ["=", "is"],
  [">", "gt"],
  ["<", "lt"],
  ["~", "contains"],
];
