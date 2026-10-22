#!/usr/bin/env node
// ui-guard: deterministic design-system + anti-slop checks.
//
// One rule set, three entry points:
//   pnpm ui:check                 scan all of src/ (CI, pre-commit)
//   node scripts/ui-guard.mjs a.tsx b.css
//   node scripts/ui-guard.mjs --hook   Claude Code PostToolUse hook: reads the
//                                      hook JSON on stdin, checks the edited
//                                      file, exits 2 with findings on stderr
//                                      so Claude fixes them immediately.
//   node scripts/ui-guard.mjs --write-baseline
//                                      Adopting into an existing codebase:
//                                      record today's violations per file+rule
//                                      in ui-guard.baseline.json. Afterwards only
//                                      NEW violations fail; shrink the baseline
//                                      as you fix files, never grow it.
//
// Suppress a finding only with a reason, on the same or the previous line:
//   {/* ui-guard-ignore no-inline-style: bar width is data-driven */}

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const TOKENS = path.join(SRC, "styles/tokens.css");
const UI_DIR = path.join(SRC, "components/ui") + path.sep;
const BASELINE = path.join(ROOT, "ui-guard.baseline.json");

const SPACING = new Set(["0", "px", "0.5", "1", "1.5", "2", "2.5", "3", "4", "5", "6", "8", "10", "12", "16", "20", "24"]);
const DURATIONS = new Set(["75", "100", "150", "200", "250", "300"]);
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const STOCK_FONTS = "Inter|Inter_Tight|Geist|Geist_Mono|Poppins|Plus_Jakarta_Sans|DM_Sans|Roboto|Open_Sans|Montserrat|Lato|Nunito|Outfit|Manrope";

/**
 * Each rule: id, level, file filter, and either a regex or a custom test.
 * `fix` is what the agent should do instead; keep it actionable.
 */
const RULES = [
  {
    id: "no-raw-color",
    level: "error",
    applies: (f) => f !== TOKENS && /\.(tsx?|css)$/.test(f),
    re: /(?<![&\w/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?!["'`]?\s*:)|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/g,
    msg: "Raw color value outside tokens.css.",
    fix: "Use a semantic utility (bg-card, text-muted-foreground, text-danger) or var(--ap-*). New color? Add a token to src/styles/tokens.css and run pnpm ui:contrast.",
  },
  {
    id: "no-inline-style",
    level: "error",
    applies: (f) => /\.tsx$/.test(f),
    test(line) {
      const hits = [];
      // Lazy match up to the closing `}}` (or `} as CSSProperties}`), so template
      // literals inside the object can't hide a key from the check.
      for (const m of line.matchAll(/style=\{\{(.*?)\}(?:\s+as\s+[\w.]+)?\}/g)) {
        const keys = [...m[1].matchAll(/(["'][^"']+["']|[A-Za-z_$][\w$]*)\s*:/g)].map((k) => k[1].replace(/["']/g, ""));
        if (keys.length && keys.every((k) => k.startsWith("--"))) continue; // custom properties only = allowed
        hits.push(m.index);
      }
      if (/style=\{(?!\{)/.test(line)) hits.push(line.indexOf("style={"));
      return hits;
    },
    msg: "Inline style object.",
    fix: "Use Tailwind utilities. For data-driven geometry pass a CSS custom property: style={{ '--bar': `${pct}%` }} + a class that reads it.",
  },
  {
    id: "no-arbitrary-value",
    level: "error",
    applies: (f) => /\.tsx?$/.test(f),
    re: /(?<![\w[])-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\[[^\]\s"'`]+\](?!:)|(?<=["'`\s])\[[a-z-]+:[^\]\s]+\](?!:)/g,
    msg: "Tailwind arbitrary value (off-scale).",
    fix: "Use the nearest scale step (spacing, text-*, rounded-*, shadow-*). If the value is genuinely new, add a token in globals.css @theme instead.",
  },
  {
    id: "no-css-var-shorthand",
    level: "warn",
    applies: (f) => /\.tsx?$/.test(f) && !f.startsWith(UI_DIR),
    re: /\b[a-z]+(?:-[a-z]+)*-\(--[a-z0-9-]+\)/g,
    msg: "Utility reads a raw CSS variable.",
    fix: "Prefer the semantic utility (bg-brand, text-subtle-foreground). Raw var shorthands are for primitives in components/ui only.",
  },
  {
    id: "no-palette-color",
    level: "error",
    applies: (f) => /\.tsx?$/.test(f),
    re: new RegExp(
      `\\b(?:bg|text|border|ring|fill|stroke|outline|decoration|divide|shadow|accent|caret|placeholder|from|via|to)-(?:(?:${PALETTE})-\\d{2,3}|white|black)\\b`,
      "g",
    ),
    msg: "Stock Tailwind palette color (does not exist in this theme).",
    fix: "Use semantic tokens: text-foreground / text-muted-foreground / text-subtle-foreground, bg-card / bg-muted, text-success|warning|danger|info, bg-brand.",
  },
  {
    id: "no-gradient",
    level: "error",
    applies: (f) => /\.(tsx?|css)$/.test(f),
    re: /\bbg-(?:gradient-to|linear|radial|conic)-?|\b(?:linear|radial|conic)-gradient\(|\bbg-clip-text\b|\btext-transparent\b/g,
    msg: "Gradient / gradient text: the most recognizable AI-generated tell.",
    fix: "Solid surfaces only. Emphasis comes from type weight, the brand accent used sparingly, or layout, never gradients.",
  },
  {
    id: "no-glow",
    level: "error",
    applies: (f) => /\.tsx?$/.test(f),
    re: /(?<![\w-])(?:blur-(?:xl|2xl|3xl)|backdrop-blur(?:-\w+)?|drop-shadow(?:-\w+)?|shadow-(?:md|lg|xl|2xl|inner))\b/g,
    msg: "Glow, blur or heavy drop shadow.",
    fix: "Depth comes from the token shadows only: shadow-panel, shadow-control, shadow-control-primary, shadow-overlay.",
  },
  {
    id: "no-attention-motion",
    level: "error",
    applies: (f) => /\.tsx?$/.test(f) && !/components\/ui\/spinner\.tsx$/.test(f),
    re: /\banimate-(?:bounce|ping|pulse|spin)\b|\bhover:(?:-?scale|-?translate|-?rotate)-\S+/g,
    msg: "Attention-seeking motion.",
    fix: "Motion confirms an action; it never decorates. Use <Spinner/> for pending, <Skeleton/> for loading, transitions on color/opacity/transform ≤ 200ms.",
  },
  {
    id: "no-transition-all",
    level: "warn",
    applies: (f) => /\.tsx?$/.test(f),
    re: /\btransition-all\b/g,
    msg: "transition-all animates layout properties.",
    fix: "Use transition-colors, transition-opacity or transition-transform.",
  },
  {
    id: "no-banned-import",
    level: "error",
    applies: (f) => /\.tsx?$/.test(f),
    re: /from\s+["'](?:lucide-react|react-icons(?:\/[^"']*)?|@heroicons\/[^"']+|@tabler\/icons-react|@radix-ui\/react-icons|framer-motion)["']/g,
    msg: "Banned dependency (default AI-stack icon set or animation lib).",
    fix: "Icons: @phosphor-icons/react (via components/ui/icon). Motion: CSS transitions with the token easing.",
  },
  {
    id: "no-stock-font",
    level: "error",
    applies: (f) => /\.(tsx?|css)$/.test(f),
    re: new RegExp(
      `import\\s*\\{[^}]*\\b(?:${STOCK_FONTS})\\b[^}]*\\}\\s*from\\s*["']next/font/google["']|font-family:[^;]*\\b(?:${STOCK_FONTS.replace(/_/g, " ")})\\b`,
      "g",
    ),
    msg: "Default AI-stack typeface.",
    fix: "Typography is IBM Plex Sans + IBM Plex Mono, wired once in src/app/layout.tsx. Use font-sans / font-mono.",
  },
  {
    id: "no-emoji",
    level: "error",
    applies: (f) => /\.tsx?$/.test(f),
    re: /\p{Extended_Pictographic}/gu,
    msg: "Emoji in UI source.",
    fix: "Use an icon from components/ui/icon with an accessible label, or plain words.",
  },
  {
    id: "no-heavy-weight",
    level: "warn",
    applies: (f) => /\.tsx?$/.test(f),
    re: /\bfont-(?:bold|extrabold|black)\b/g,
    msg: "Weight above semibold.",
    fix: "Use font-medium for emphasis and font-semibold for headings and figures. Hierarchy comes from size and color, not weight.",
  },
  {
    id: "no-oversized-type",
    level: "warn",
    applies: (f) => /\.tsx?$/.test(f),
    re: /\btext-(?:[4-9]xl)\b|\brounded-(?:2xl|3xl|4xl)\b/g,
    msg: "Off-scale size or radius (marketing-page proportions).",
    fix: "App type tops out at text-3xl (one hero figure per view); radius at rounded-xl (dialogs).",
  },
  {
    id: "no-placeholder-copy",
    level: "error",
    applies: (f) => /\.tsx?$/.test(f),
    re: /\blorem ipsum\b|\bJohn Doe\b|\bJane Doe\b|\bfoo@bar\b/gi,
    msg: "Placeholder copy.",
    fix: "Write real, domain-specific copy (endpoint paths, status codes, project names).",
  },
  {
    id: "no-generic-copy",
    level: "warn",
    applies: (f) => /\.tsx$/.test(f),
    re: /\b(?:Welcome back|Oops|Click here|Something went wrong|Unlock the power|Supercharge|Seamless(?:ly)?|Effortless(?:ly)?|Elevate your)\b/gi,
    msg: "Generic or hype copy.",
    fix: "Say what happened and what to do next: \"Couldn't load endpoints. Retry\". See .claude/skills/aperture-ui/references/copy.md.",
  },
  {
    id: "no-raw-control",
    level: "warn",
    applies: (f) => /\.tsx$/.test(f) && !f.startsWith(UI_DIR),
    re: /<(?:button|input|select|textarea)\b/g,
    msg: "Raw form control outside components/ui.",
    fix: "Compose from primitives: Button, IconButton, Input, Select, Switch (src/components/ui).",
  },
  {
    id: "no-dark-variant",
    level: "warn",
    applies: (f) => /\.tsx$/.test(f) && !f.startsWith(UI_DIR),
    re: /\bdark:[\w-]/g,
    msg: "dark: variant in feature code.",
    fix: "Tokens already switch per theme. If something differs per theme, it needs a token, not a variant.",
  },
  {
    id: "spacing-scale",
    level: "warn",
    applies: (f) => /\.tsx?$/.test(f),
    test(line) {
      const hits = [];
      const re = /(?<![\w-])-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?|px)\b/g;
      for (const m of line.matchAll(re)) if (!SPACING.has(m[1])) hits.push(m.index);
      return hits;
    },
    msg: "Spacing off the 4px rhythm.",
    fix: `Allowed steps: ${[...SPACING].join(", ")} (×4px).`,
  },
  {
    id: "duration-scale",
    level: "warn",
    applies: (f) => /\.tsx?$/.test(f),
    test(line) {
      const hits = [];
      for (const m of line.matchAll(/\bduration-(\d+)\b/g)) if (!DURATIONS.has(m[1])) hits.push(m.index);
      return hits;
    },
    msg: "Off-scale duration.",
    fix: "Use duration-100 (hover), duration-150 (state), duration-200 (overlay in), max duration-300.",
  },
  {
    id: "no-template-chrome",
    level: "warn",
    applies: (f) => /\.tsx$/.test(f),
    re: /\buppercase\b|\btracking-(?:wide|wider|widest)\b|\bborder-[lrse]-(?:2|4|8)\b|→\s*(?=<\/|["'`])/g,
    msg: "Template chrome: ALL-CAPS eyebrow, tracked kicker, side-stripe border or trailing arrow.",
    fix: "Sentence-case labels in text-muted-foreground; state via a badge or status dot; buttons say verb + object without arrows.",
  },
  {
    id: "no-three-dots",
    level: "warn",
    applies: (f) => /\.tsx$/.test(f),
    re: /(?<![.{\w])\.\.\.(?=["'`<\s]|$)/gm,
    msg: "Three periods instead of an ellipsis.",
    fix: 'Use the ellipsis character: "Saving…", "Rename…".',
  },
  {
    id: "no-clickable-div",
    level: "warn",
    applies: (f) => /\.tsx$/.test(f),
    re: /<(?:div|span|li|td|tr)\b[^>]*\bonClick=/g,
    msg: "Click handler on a non-interactive element.",
    fix: "Actions are <Button>, navigation is <Link>. Both are keyboard-reachable by default.",
  },
  {
    id: "no-adhoc-format",
    level: "warn",
    applies: (f) => /\.tsx$/.test(f),
    re: /\.toFixed\(|\.toLocaleString\(|\.toDateString\(|\.toLocaleDateString\(/g,
    msg: "Ad-hoc number/date formatting.",
    fix: "Use src/lib/format.ts (formatCount, formatDuration, formatPercent, formatTimestamp, formatRelative).",
  },
  {
    id: "no-important",
    level: "error",
    applies: (f) => /\.css$/.test(f),
    re: /!important\b/g,
    msg: "!important.",
    fix: "Fix the cascade (layer or specificity) instead.",
  },
];

function lineCol(src, index) {
  const before = src.slice(0, index);
  const line = before.split("\n").length;
  return { line, col: index - before.lastIndexOf("\n") };
}

function suppressed(lines, lineNo, id) {
  const re = new RegExp(`ui-guard-ignore\\s+${id}\\s*:\\s*\\S`);
  return re.test(lines[lineNo - 1] ?? "") || re.test(lines[lineNo - 2] ?? "");
}

function stripComments(src, file) {
  // Keep offsets stable: replace comment bodies with spaces, keep newlines.
  const blank = (s) => s.replace(/[^\n]/g, " ");
  let out = src.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (/\.tsx?$/.test(file)) out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
  return out;
}

export function check(file) {
  const abs = path.resolve(file);
  if (!existsSync(abs)) return [];
  const raw = readFileSync(abs, "utf8");
  const src = stripComments(raw, abs);
  const lines = raw.split("\n");
  const findings = [];
  for (const rule of RULES) {
    if (!rule.applies(abs)) continue;
    if (rule.re) {
      for (const m of src.matchAll(rule.re)) {
        const { line, col } = lineCol(src, m.index);
        if (!suppressed(lines, line, rule.id)) findings.push({ file: abs, line, col, rule, match: m[0] });
      }
    } else {
      src.split("\n").forEach((text, i) => {
        for (const idx of rule.test(text)) {
          if (!suppressed(lines, i + 1, rule.id))
            findings.push({ file: abs, line: i + 1, col: idx + 1, rule, match: text.slice(idx, idx + 40).trim() });
        }
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.col - b.col);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

function format(findings) {
  return findings
    .map(
      (f) =>
        `${path.relative(ROOT, f.file)}:${f.line}:${f.col}  ${f.rule.level.padEnd(5)}  ${f.rule.id}  ${f.rule.msg}  [${f.match}]\n    fix: ${f.rule.fix}`,
    )
    .join("\n");
}

const keyOf = (f) => `${path.relative(ROOT, f.file)}::${f.rule.id}`;

function loadBaseline() {
  if (!existsSync(BASELINE)) return null;
  return JSON.parse(readFileSync(BASELINE, "utf8"));
}

/** Findings whose file+rule count is within the baseline are tolerated debt; any excess fails. */
function applyBaseline(findings, baseline) {
  if (!baseline) return { fresh: findings, tolerated: 0 };
  const groups = new Map();
  for (const f of findings) groups.set(keyOf(f), [...(groups.get(keyOf(f)) ?? []), f]);
  const fresh = [];
  let tolerated = 0;
  for (const [key, list] of groups) {
    if (list.length <= (baseline[key] ?? 0)) tolerated += list.length;
    else fresh.push(...list);
  }
  return { fresh, tolerated };
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--hook") {
    let payload = {};
    try {
      payload = JSON.parse(await readStdin());
    } catch {
      process.exit(0);
    }
    const file = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath;
    if (!file) process.exit(0);
    const abs = path.resolve(file);
    if (!abs.startsWith(SRC + path.sep) || !/\.(tsx?|css)$/.test(abs)) process.exit(0);
    const { fresh: findings } = applyBaseline(check(abs), loadBaseline());
    const errors = findings.filter((f) => f.rule.level === "error");
    if (errors.length) {
      process.stderr.write(
        `ui-guard: ${errors.length} design-system violation(s) in ${path.relative(ROOT, abs)}. Fix before continuing:\n${format(findings)}\n`,
      );
      process.exit(2);
    }
    if (findings.length) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `ui-guard warnings in ${path.relative(ROOT, abs)} (fix unless there is a stated reason):\n${format(findings)}`,
          },
        }),
      );
    }
    process.exit(0);
  }

  if (args[0] === "--write-baseline") {
    const counts = {};
    for (const f of walk(SRC).flatMap(check)) counts[keyOf(f)] = (counts[keyOf(f)] ?? 0) + 1;
    writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`ui-guard: baseline written (${total} existing finding(s) across ${Object.keys(counts).length} file/rule pairs).`);
    process.exit(0);
  }

  const files = args.length ? args : walk(SRC);
  const { fresh: findings, tolerated } = applyBaseline(files.flatMap(check), loadBaseline());
  const errors = findings.filter((f) => f.rule.level === "error").length;
  const warns = findings.length - errors;
  if (findings.length) console.log(format(findings));
  console.log(
    `\nui-guard: ${files.length} files, ${errors} error(s), ${warns} warning(s)${tolerated ? `, ${tolerated} baselined` : ""}`,
  );
  process.exit(errors ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
