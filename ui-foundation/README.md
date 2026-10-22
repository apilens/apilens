# Aperture UI foundation

A standalone, from-scratch UI workspace for APILens. It has two halves:

1. **A reference implementation:** design tokens, primitives, multi-tenant patterns, a living `/design` page and a small demo app, all built so they don't look AI-generated.
2. **An AI workspace layer:** the rules, skills, hooks, reviewer agent and checks that make Claude Code (or any agent) produce UI that matches the reference, every time.

Nothing in `apps/web` was changed. This folder is invisible to the monorepo's pnpm workspace and turbo. It is its own pnpm root, so its lockfile is separate from yours.

```
cd ui-foundation
pnpm install
pnpm dev            # http://localhost:3100  →  /design and /projects/checkout-api
claude              # launch Claude Code HERE so hooks, MCP and the reviewer agent load
```

## What's inside

```
AGENTS.md                      tool-agnostic rules (12 non-negotiables, commands, map); Next.js manages one block in it
CLAUDE.md                      imports AGENTS.md + Claude Code specifics
DESIGN.md                      Google Labs DESIGN.md format; tokens generated from tokens.css, prose by hand
.claude/
  settings.json                PostToolUse hook → ui-guard; narrow allowlist (checks + browser tools)
  skills/aperture-ui/          auto-loaded design-system skill + 7 reference files
  skills/new-screen/           /new-screen: spec → compose → states → checks → visual verification
  skills/ui-audit/             /ui-audit: scripted + visual audit, ranked findings (+ 38-item checklist)
  agents/design-reviewer.md    read-only Playwright reviewer (both themes, 1440 + 390, keyboard pass)
  rules/                       path-scoped rules for primitives and routes
.mcp.json                      playwright + shadcn MCP servers
scripts/
  ui-guard.mjs                 the anti-slop / design-system checker (hook, CLI, CI, baseline mode)
  check-contrast.mjs           WCAG contrast for every token pair, both themes
  sync-design-md.mjs           tokens.css → DESIGN.md front matter
src/styles/tokens.css          the only file with raw colors
src/app/globals.css            Tailwind v4 theme: stock scales cleared, Aperture scales defined
src/components/ui/             17 primitives (Radix-based, cva variants)
src/components/patterns/       app shell, project switcher, Gated, DangerZone, StatTile, states, banners…
src/app/design/                living reference: every token and component in every state
src/app/projects/[slug]/       demo: overview, settings (try /projects/partner-sync for the viewer role)
tests/visual.spec.ts           screenshot regression: 3 routes × 2 themes × 2 widths + focus check
ci/github-workflow.yml         CI template (not active; copy to enable)
```

## How consistency is enforced

Rules alone don't hold. Each layer below catches what the one before it misses.

| Layer | What | When it runs |
|---|---|---|
| **Theme** | Stock Tailwind palette, shadow, radius, type, blur and ease scales are *cleared*. `bg-blue-500`, `shadow-xl`, `rounded-2xl` and `text-5xl` don't exist here | always |
| **Context** | `CLAUDE.md` → `AGENTS.md`, the `aperture-ui` skill + references, `DESIGN.md`, path-scoped rules, the `/design` page | every session / on demand |
| **Hook** | `ui-guard --hook` after every Edit/Write in `src/`. Errors exit 2 and go back to Claude to fix in the same turn | every edit |
| **Lint** | `@shadcn/lint` (no restyling primitives at call sites, unknown classes, raw colors, inline styles) + Next/React rules | `pnpm check`, editor |
| **Contrast** | every text/surface pair in both themes, computed (not eyeballed) | `pnpm check` |
| **Visual** | Playwright MCP screenshots during work, the `design-reviewer` agent, `toHaveScreenshot` baselines | `/new-screen`, `/ui-audit`, `pnpm test:visual` |

`ui-guard` blocks: raw colors, inline styles, arbitrary values, stock palette classes, gradients and gradient text, glows and blur, attention motion (bounce, ping, pulse, hover-scale), banned icon and animation libraries, stock AI fonts, emoji, placeholder copy. It warns on: heavy weights, oversized type, generic/hype copy, raw form controls, `dark:` in feature code, off-scale spacing and durations, ALL-CAPS eyebrows, side-stripe borders, `...`, clickable divs and ad-hoc number formatting. Suppressions need a written reason.

## Working with Claude Code

- **Just ask for UI.** The `aperture-ui` skill loads automatically: compose from primitives, all four states, checks, then screenshots in both themes and widths.
- **`/new-screen consumers list with per-consumer error rates`** runs the full workflow with a written spec first.
- **`/ui-audit /projects/checkout-api`** runs a read-only audit; findings come back ranked blocker → nit with fixes.
- When Claude says done, it should tell you what it verified visually. If it didn't, ask.

## Decisions (and why)

| Decision | Why |
|---|---|
| shadcn architecture on **Radix**, code owned in-repo | primitives are invisible; the look is ours. Linear and Vercel ship on Radix. Radix is actively maintained (commits Oct 2026). shadcn token names match the model's priors |
| **IBM Plex Sans + Plex Mono** | equal-width digits (columns align), a true mono sibling for paths and keys, and not one of the default AI-stack fonts |
| **Phosphor** icons via one curated module (`/ssr` path) | not the Lucide default; RSC-safe; one place to add icons |
| **Inverted-neutral primary button**, teal only for focus, selection, links and live | keeps teal under ~5% of pixels; avoids the "cyan-on-dark" tell |
| **Control depth recipe** (inset hairline + top highlight + bottom edge) | the "made, not generated" quality, tuned per theme (highlights on dark) |
| **Tinted neutrals** (hue 235), three text inks | reads designed rather than stock zinc; fewer grays = fewer choices to get wrong |
| **Dense scale**: 13px UI text, 28/32/36 controls, 36px rows | an observability tool, not a marketing page |
| **Validated chart palette** (dataviz six checks, both themes) | colorblind-safe by computation; light-mode relief rule documented |
| **Permissions as a contract** (`capabilities.ts` ↔ OPA, `useCan`, `Gated`, `Field editableBy`) | one vocabulary across backend and UI; disable + reason vs hide vs read-only chosen by rule |

## Versions that matter

Next 16.4, React 19.3, Tailwind 4.3, radix-ui 1.8, `@shadcn/lint` 0.2.3, `@google/design.md` 0.4.0.
**TypeScript is pinned to 6.0.x and ESLint to 9.x**, because typescript-eslint doesn't support TS 7 and the React/import/a11y plugins stop at ESLint 9. Phosphor must be imported from `@phosphor-icons/react/ssr` (via `@/components/ui/icon`), or server components crash.

## Bringing this into apps/web later

Suggested order, one PR each:

1. Copy `.claude/`, `scripts/`, `AGENTS.md`/`CLAUDE.md` and `DESIGN.md` into `apps/web`. Run `node scripts/ui-guard.mjs --write-baseline` there so today's debt (about 199 inline styles and 111 hex colors) is recorded and **only new violations fail**.
2. Replace the token bridge on `reui-revamp` (`reui.tokens.css`) with `tokens.css` + the `globals.css` theme block. Clearing the stock scales will surface every off-system class. Fix those first.
3. Move primitives from `components/reui` and `components/aperture` to these `components/ui` versions, keeping the same props where possible.
4. Migrate one surface per PR (Endpoints → Errors → Traffic …). After each, shrink the baseline (`--write-baseline` again) and add a visual test.
5. Enable `ci/github-workflow.yml`.

## Research behind this

Vercel Web Interface Guidelines · Anthropic `frontend-design` (2026-09 rewrite; deliberately not used here) · Impeccable (pbakaus) detector rules · blode.co "You don't have to make AI slop" · Linear UI redesign notes · Matt Ström on UI density · Carbon, Primer, Polaris and Atlassian guidance on tables, states, banners and disabled controls · WorkOS, Clerk, Stripe, Sentry, Datadog and GitHub docs on tenancy, permissions, API keys and audit logs · Google Labs DESIGN.md spec · shadcn CLI v4 and `@shadcn/lint` docs · measurements of plumeui.com's control depth.
