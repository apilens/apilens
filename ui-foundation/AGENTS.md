# Aperture UI foundation: agent rules

This folder is the APILens UI system: design tokens, primitives, multi-tenant
patterns, a living reference page, and the checks that keep AI-written UI
consistent. Read this file before writing any UI. Detail lives in `DESIGN.md`
and `.claude/skills/aperture-ui/`.

The bar: every screen should look like it was designed by one careful person
who has seen Linear, Vercel and Sentry, never like a template. Distinctiveness
comes from precision (spacing, type, depth, copy), not novelty.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server on http://localhost:3100 |
| `pnpm check` | ui-guard + contrast + typecheck + ESLint. Must pass before you say "done" |
| `pnpm ui:check [files]` | Design-system and anti-slop checks (`scripts/ui-guard.mjs`) |
| `pnpm ui:contrast` | WCAG contrast for every token pair in both themes |
| `pnpm design:sync` / `pnpm design:lint` | Regenerate / lint `DESIGN.md` tokens from `src/styles/tokens.css` |
| `pnpm test:visual` | Playwright screenshot tests (dark + light, 1440 + 390) |

## Map

```
src/styles/tokens.css        the ONLY file with raw color values (both themes)
src/app/globals.css          Tailwind theme: stock scales cleared, Aperture scales defined
src/components/ui/           primitives (Button, Input, Field, Panel, Table, Dialog, …)
src/components/patterns/     app patterns (AppShell, ProjectSwitcher, Gated, DangerZone, StatTile, states…)
src/lib/format.ts            every number, duration, percent and timestamp goes through here
src/lib/capabilities.ts      permission vocabulary shared with the backend (OPA)
src/app/design/page.tsx      living reference: every token + component in every state
src/app/projects/[slug]/     demo app built only from the foundation
```

## Non-negotiables

1. **Compose, don't invent.** Build from `components/ui` and `components/patterns`. Need something new? Add it as a primitive or pattern, add it to `/design`, then use it. Never restyle a primitive at the call site (only layout and spacing classes are allowed there; `@shadcn/lint` enforces this).
2. **Tokens only.** No hex/rgb/oklch outside `tokens.css`, no `style={{}}`, no arbitrary Tailwind values (`p-[13px]`). Stock palette classes (`bg-blue-500`) don't exist in this theme.
3. **Color means something.** Neutral surfaces; teal `brand` only for focus, selection, links and live state; `success/warning/danger/info` only for status (2xx/4xx/5xx). Primary buttons are inverted neutral, not teal.
4. **No AI tells.** No gradients, glows, blur, glass, emoji, hover-lift or scale, bouncing or pulsing decoration, ALL-CAPS eyebrows, three-card feature rows, "Welcome back" heroes, or buzzwords.
5. **Dense and calm.** UI text is `text-sm` (13px); controls are 28/32/36px; rows are 36px; spacing stays on the 4px scale; weights are 400/500/600 only.
6. **Type.** IBM Plex Sans for UI, IBM Plex Mono for paths, ids, keys and code. Numbers in tables use `tabular-nums` and are right-aligned. Format through `lib/format.ts`.
7. **Every data surface ships four states:** populated, empty (says what will appear plus one action), loading (skeleton shaped like the content), error (what failed, what to do, request id).
8. **Tenancy is always visible.** The active project shows in the switcher, environment is labeled, and permissions come from the backend through `useCan` / `<Gated>` / `Field editableBy`. UI gating is UX; the server enforces.
9. **Copy.** Sentence case everywhere. Buttons are verb + object ("Create API key"). Errors say what happened and what to do. No "Oops", "Something went wrong", or exclamation marks.
10. **Motion confirms, never performs.** 100–200ms ease-out on color, opacity and transform only. Respect reduced motion.
11. **Accessible by construction.** Visible focus (`focus-ring`), labels on icon-only buttons, real `<button>`/`<Link>`, status never shown by color alone.
12. **Verify visually.** After UI changes, look at the page in dark and light, at 1440 and 390 wide, and compare with `/design`. Passing lint is not the same as looking right.

## Building a screen

1. Write a 5-line spec: the object the page is about, the one primary action, the data, the states, the permissions.
2. Find the closest existing screen or pattern and copy its structure (`PageHeader` → `StatRow` → `Panel`s).
3. Compose from primitives. Server components by default; client only where there's interaction.
4. Fill every state with real, domain-specific copy (endpoint paths, status codes; never lorem ipsum).
5. Run `pnpm check`, then verify visually. Fix what you see, not just what lint reports.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
