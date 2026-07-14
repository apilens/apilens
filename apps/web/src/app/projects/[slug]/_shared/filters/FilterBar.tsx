"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Filter, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/reui/popover";
import {
  FIELDS,
  FIELD_MAP,
  OP_LABELS,
  OP_SHORTHANDS,
  type FieldSpec,
  type Op,
} from "./schema";
import {
  addValues,
  describe,
  parseFilter,
  parseToken,
  predicateKey,
  serializeFilter,
  toggleValue,
  upsertPredicate,
  type Predicate,
} from "./query";

/* ── Hybrid filter bar ───────────────────────────────────────────────────
   Chips + a typed token input. Set-op fields get a live multi-select
   checklist; large fields (consumer/path/ip/ua) are searched server-side —
   only once the user types, with results cached per term. Any "done" gesture
   (Enter / Done / Esc / click-away) clears the in-progress token so the next
   filter starts from an empty input. */

interface Props {
  projectSlug: string;
  value: string;
  onChange: (filter: string) => void;
  // Fields to omit from the field picker (e.g. a page that owns `app` via a
  // dedicated control, or the Consumers page which is already per-consumer).
  exclude?: string[];
}

type ValueOption = { label: string; value: string };
type Stage = "field" | "op" | "value";

// Fields whose value lists are unbounded → searched on the server, on demand.
const SERVER_FIELDS = new Set(["consumer", "path", "ip", "ua"]);

type MenuItem =
  | { kind: "nav"; label: string; hint?: string; apply: string }
  | { kind: "commit"; label: string; hint?: string; predicate: Predicate }
  | { kind: "toggle"; label: string; hint?: string; field: string; op: Op; value: string; negate: boolean; checked: boolean };

function canonicalOp(token: string): Op | null {
  const t = token.toLowerCase();
  if (t in OP_LABELS) return t as Op;
  const sh = OP_SHORTHANDS.find(([s]) => s === token);
  return sh ? sh[1] : null;
}

// Work out what the user is mid-typing so we know what to suggest. Field names
// are matched case-insensitively and returned canonical (lower-case).
function analyze(text: string): { stage: Stage; neg: string; field: string; op: Op | null; q: string } {
  let t = text.trimStart();
  let neg = "";
  if (t.startsWith("-")) {
    neg = "-";
    t = t.slice(1);
  }
  const colon = t.indexOf(":");
  if (colon === -1) return { stage: "field", neg, field: "", op: null, q: t };

  const field = t.slice(0, colon).trim().toLowerCase();
  const rest = t.slice(colon + 1);
  if (!FIELD_MAP[field]) return { stage: "field", neg, field: "", op: null, q: t };

  for (const [sh, op] of OP_SHORTHANDS) {
    if (rest.startsWith(sh)) return { stage: "value", neg, field, op, q: rest.slice(sh.length).trimStart() };
  }
  const c2 = rest.indexOf(":");
  if (c2 === -1) return { stage: "op", neg, field, op: null, q: rest.trim() };
  const op = canonicalOp(rest.slice(0, c2).trim());
  return { stage: "value", neg, field, op: op ?? "is", q: rest.slice(c2 + 1).trimStart() };
}

export default function FilterBar({ projectSlug, value, onChange, exclude }: Props) {
  const predicates = useMemo(() => parseFilter(value), [value]);
  const fields = useMemo(() => FIELDS.filter((f) => !exclude?.includes(f.field)), [exclude]);

  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [envOptions, setEnvOptions] = useState<string[]>([]);
  const [appOptions, setAppOptions] = useState<ValueOption[]>([]);
  const [serverOptions, setServerOptions] = useState<ValueOption[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const cacheRef = useRef<Map<string, ValueOption[]>>(new Map());
  const attemptedRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const a = useMemo(() => analyze(text), [text]);
  const spec = a.field ? FIELD_MAP[a.field] : undefined;
  const isServer = a.stage === "value" && SERVER_FIELDS.has(a.field);
  const showChecklist = a.stage === "value" && (a.op === "is" || a.op === "not" || a.op === null);

  const learnLabels = useCallback((opts: ValueOption[]) => {
    setLabels((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const o of opts) {
        if (o.label && o.label !== o.value && next[o.value] !== o.label) {
          next[o.value] = o.label;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Static / small value sources loaded once.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/environments`);
        if (res.ok) setEnvOptions((await res.json()).environments || []);
      } catch { /* ignore */ }
    })();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps`);
        if (res.ok) {
          const data = await res.json();
          const opts = (data.apps || []).map((x: { name: string; slug: string }) => ({ label: x.name, value: x.slug }));
          setAppOptions(opts);
          learnLabels(opts);
        }
      } catch { /* ignore */ }
    })();
  }, [projectSlug, learnLabels]);

  // Resolve display names for consumer values already in the filter (shared
  // ?filter= URLs), so chips show names not ids. Tried-once per value.
  useEffect(() => {
    const missing = predicates
      .filter((p) => p.field === "consumer")
      .flatMap((p) => p.values)
      .filter((v) => v && !labels[v] && !attemptedRef.current.has(v));
    if (!missing.length) return;
    missing.forEach((v) => attemptedRef.current.add(v));
    let cancelled = false;
    (async () => {
      for (const v of missing.slice(0, 12)) {
        try {
          const p = new URLSearchParams({ field: "consumer", q: v, limit: "5" });
          const res = await fetch(`/api/projects/${projectSlug}/analytics/filter-values?${p.toString()}`);
          const data = res.ok ? await res.json() : [];
          if (cancelled) return;
          const m = (Array.isArray(data) ? data : []).find((d: { value?: string }) => d.value === v);
          if (m?.label) learnLabels([{ label: m.label, value: v }]);
        } catch { /* ignore */ }
      }
    })();
    return () => { cancelled = true; };
    // Intentionally not depending on `labels` — attemptedRef prevents refetch loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predicates, projectSlug, learnLabels]);

  // On-demand, cached server search — only once the user types.
  useEffect(() => {
    if (!open || !isServer) {
      setServerOptions([]);
      setServerLoading(false);
      return;
    }
    const term = a.q.trim();
    if (!term) {
      setServerOptions([]);
      setServerLoading(false);
      return;
    }
    const key = `${a.field}::${term.toLowerCase()}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setServerOptions(cached);
      setServerLoading(false);
      return;
    }
    let cancelled = false;
    setServerLoading(true);
    const handle = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ field: a.field, q: term, limit: "20" });
        p.set("since", new Date(Date.now() - 90 * 864e5).toISOString());
        const res = await fetch(`/api/projects/${projectSlug}/analytics/filter-values?${p.toString()}`);
        const data = res.ok ? await res.json() : [];
        if (cancelled) return;
        const opts: ValueOption[] = (Array.isArray(data) ? data : [])
          .map((d: { label?: string; value?: string }) => {
            const v = d.value || d.label || "";
            return { label: d.label || v, value: v };
          })
          .filter((o: ValueOption) => o.value);
        cacheRef.current.set(key, opts);
        learnLabels(opts);
        setServerOptions(opts);
      } catch {
        if (!cancelled) setServerOptions([]);
      } finally {
        if (!cancelled) setServerLoading(false);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [open, isServer, a.field, a.q, projectSlug, learnLabels]);

  // Close + discard the in-progress token on outside click. The suggestion
  // menu is portaled (ReUI Popover), so "inside" = the bar OR the menu.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inMenu =
        target instanceof Element && !!target.closest("[data-flt-menu]");
      if (rootRef.current && !rootRef.current.contains(target) && !inMenu) {
        setOpen(false);
        setText("");
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const labelFor = useCallback((v: string) => labels[v] ?? v, [labels]);

  const localOptions = useCallback(
    (s: FieldSpec): ValueOption[] => {
      if (s.valueSource === "env") return envOptions.map((e) => ({ label: e, value: e }));
      if (s.valueSource === "app") return appOptions;
      if (s.values) return s.values.map((v) => ({ label: v, value: v }));
      if (s.suggest) return s.suggest.map((v) => ({ label: v, value: v }));
      return [];
    },
    [envOptions, appOptions],
  );

  const items = useMemo<MenuItem[]>(() => {
    const q = a.q.toLowerCase();

    if (a.stage === "field") {
      return fields.filter((f) => f.field.includes(q) || f.label.toLowerCase().includes(q))
        .slice(0, 10)
        .map((f) => ({ kind: "nav", label: f.label, hint: f.field, apply: `${a.neg}${f.field}:` }));
    }
    if (!spec) return [];

    if (a.stage === "op") {
      return spec.ops
        .filter((op) => op.includes(q) || OP_LABELS[op].toLowerCase().includes(q))
        .map((op) => ({ kind: "nav", label: OP_LABELS[op], hint: op, apply: `${a.neg}${a.field}:${op}:` }));
    }

    const op = a.op ?? "is";
    const raw = SERVER_FIELDS.has(a.field)
      ? serverOptions
      : localOptions(spec).filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));

    if (op === "is" || op === "not") {
      const cur = predicates.find((p) => p.field === a.field);
      return raw.slice(0, 20).map((o) => ({
        kind: "toggle",
        label: o.label,
        hint: o.label !== o.value ? o.value : undefined,
        field: a.field,
        op,
        value: o.value,
        negate: !!a.neg,
        checked: !!cur?.values.includes(o.value),
      }));
    }
    return raw.slice(0, 20).map((o) => ({
      kind: "commit",
      label: o.label,
      hint: o.label !== o.value ? o.value : undefined,
      predicate: { field: a.field, op, values: [o.value], negate: a.neg ? true : undefined },
    }));
  }, [a, spec, serverOptions, localOptions, predicates, fields]);

  useEffect(() => { setActive(0); }, [items.length]);

  const commit = useCallback(
    (p: Predicate) => { onChange(upsertPredicate(value, p)); setText(""); },
    [value, onChange],
  );
  const remove = (idx: number) => onChange(serializeFilter(predicates.filter((_, i) => i !== idx)));
  const done = () => { setText(""); inputRef.current?.focus(); };

  const editChip = (idx: number) => {
    const p = predicates[idx];
    const neg = p.negate ? "-" : "";
    if (p.op === "is" || p.op === "not") {
      setText(`${neg}${p.field}:${p.op}:`);
    } else {
      onChange(serializeFilter(predicates.filter((_, i) => i !== idx)));
      setText(`${neg}${p.field}:${p.op}:${p.values.join(",")}`);
    }
    setOpen(true);
    inputRef.current?.focus();
  };

  const pick = (item: MenuItem) => {
    if (item.kind === "nav") {
      setText(item.apply);
      inputRef.current?.focus();
    } else if (item.kind === "commit") {
      commit(item.predicate);
    } else {
      onChange(toggleValue(value, item.field, item.op, item.value, item.negate));
      // Keep the checklist open, clear just the typed search term.
      setText(`${a.neg}${item.field}:${item.op}:`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
      setOpen(true);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      setText("");
      return;
    }
    if (e.key === "Backspace" && text === "" && predicates.length) {
      remove(predicates.length - 1);
      return;
    }
    if (e.key !== "Enter") return;

    e.preventDefault();
    const trimmed = text.trim();

    // Paste of a whole filter (contains ';').
    if (trimmed.includes(";")) {
      let next = value;
      for (const p of parseFilter(trimmed)) next = upsertPredicate(next, p);
      onChange(next);
      setText("");
      return;
    }

    if (showChecklist) {
      const it = items[active];
      if (it && it.kind === "toggle") {
        onChange(toggleValue(value, it.field, it.op, it.value, it.negate));
        setText(`${a.neg}${a.field}:${a.op ?? "is"}:`);
      } else if (a.q.trim()) {
        // Typed a value not in the suggestion list — add it.
        const p = parseToken(text);
        if (p) {
          onChange(addValues(value, a.field, a.op ?? "is", p.values, !!a.neg));
          setText(`${a.neg}${a.field}:${a.op ?? "is"}:`);
        } else {
          setText("");
        }
      } else {
        done(); // nothing selected to add → finish
      }
      return;
    }

    if (a.stage === "value") {
      // Scalar (gt/lt/between/contains…): commit the typed value or active hint.
      const direct = parseToken(text);
      if (direct) commit(direct);
      else if (items[active]) pick(items[active]);
      return;
    }

    // field / op stage
    if (open && items[active]) pick(items[active]);
  };

  const chipValue = (p: Predicate) => {
    const vals = p.values.map(labelFor);
    return p.op === "between" ? vals.join(" – ") : vals.join(", ");
  };

  const showMenu = open && (items.length > 0 || isServer);
  const hasToggle = items.some((it) => it.kind === "toggle");

  return (
    // `.flt-bar` stays: it is a layout-contract class (`.tf-filter-grow >
    // .flt-bar` / `.ep-rl-filtergrow > .flt-bar` gate sizing in page CSS).
    <div className="flt-bar" ref={rootRef}>
      <Filter size={13} className="ml-px shrink-0 text-muted-foreground" />

      {predicates.map((p, i) => {
        const d = describe(p);
        const fSpec = FIELD_MAP[p.field];
        const val = chipValue(p);
        return (
          <Badge
            key={predicateKey(p, i)}
            variant="outline"
            className="h-[22px] items-stretch gap-0 overflow-hidden rounded-md p-0 text-xs leading-none"
          >
            <button
              type="button"
              className="flex h-full items-center gap-1.5 px-2 transition-colors hover:bg-primary/10"
              onClick={() => editChip(i)}
            >
              <span className="shrink-0 font-semibold text-foreground">{d.field}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{d.op}</span>
              <span className="max-w-[280px] truncate font-mono text-primary">
                {fSpec?.unit ? `${val} ${fSpec.unit}` : val}
              </span>
            </button>
            <button
              type="button"
              className="flex h-full items-center border-l border-border px-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={() => remove(i)}
              aria-label="Remove filter"
            >
              <X size={11} />
            </button>
          </Badge>
        );
      })}

      <Popover open={showMenu}>
        <PopoverAnchor asChild>
          <div className="flex min-w-[150px] flex-1 basis-40 items-center gap-1">
            {predicates.length === 0 && !text && (
              <Plus size={12} className="shrink-0 text-muted-foreground" />
            )}
            <input
              ref={inputRef}
              className="w-full border-none bg-transparent py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              value={text}
              placeholder={predicates.length ? "" : "Filter… (e.g. status:>=500 path:~/v1/orders)"}
              onChange={(e) => { setText(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              aria-label="Add filter"
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          data-flt-menu=""
          role="listbox"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="max-h-[300px] w-auto min-w-[240px] max-w-[calc(100vw-32px)] overflow-y-auto p-1"
        >
          {isServer && !a.q.trim() && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              Type to search {spec?.label.toLowerCase()}…
            </div>
          )}
          {isServer && a.q.trim() && serverLoading && items.length === 0 && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" /> Searching…
            </div>
          )}
          {isServer && a.q.trim() && !serverLoading && items.length === 0 && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              No matches for “{a.q.trim()}”
            </div>
          )}
          {items.map((item, i) => {
            const checked = item.kind === "toggle" && item.checked;
            return (
              <button
                key={`${item.kind}:${item.label}:${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 text-left",
                  i === active && "bg-accent",
                )}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(item); }}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  {item.kind === "toggle" && (
                    <span
                      className={cn(
                        "flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border border-border bg-card",
                        checked && "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {checked && <Check size={10} />}
                    </span>
                  )}
                  <span
                    className={cn(
                      "truncate whitespace-nowrap text-[13px] text-foreground",
                      checked && "text-primary",
                    )}
                  >
                    {item.label}
                  </span>
                </span>
                {item.hint && (
                  <span className="ml-2 max-w-[45%] shrink-0 truncate whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                    {item.hint}
                  </span>
                )}
              </button>
            );
          })}
          {showChecklist && hasToggle && (
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-border py-1.5 pl-2.5 pr-1.5 text-[11px] text-muted-foreground">
              <span>Select multiple · Esc to cancel</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="font-semibold"
                onMouseDown={(e) => { e.preventDefault(); done(); }}
              >
                Done
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {predicates.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto shrink-0 font-normal text-muted-foreground hover:text-foreground"
          onClick={() => { onChange(""); setText(""); }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
