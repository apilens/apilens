---
name: aperture-ui
description: The APILens design system (Aperture) for building and changing product UI without it looking AI-generated. Use for ANY UI work in this project, even small tweaks. That means creating or editing a page, component, layout, form, table, chart, empty/loading/error state, style, color, icon, spacing, copy or microcopy, and adding shadcn/registry components.
when_to_use: User asks to build a screen, add a component, restyle something, fix layout, write UI copy, add a chart or KPI, handle permissions in the UI, or make something "look better / less generic".
---

# Aperture: building APILens UI

Aperture is the visual and interaction language of APILens. The goal is UI that
reads as designed by one careful person: calm, dense, precise, trustworthy with
numbers. You get there by **composing what exists and following the scales**, not
by being creative per screen. Distinctiveness lives in the system (tuned
neutrals, control depth, Plex type, exact copy), so individual screens should
be quiet.

## The workflow (every UI task)

1. **Locate the reference.** Open `src/app/design/page.tsx` and the closest real screen (`src/app/projects/[slug]/page.tsx` for dashboards, `.../settings/page.tsx` for forms and tables). Copy their structure.
2. **Spec it in 5 lines** (in your head or the reply): the object the page is about · the ONE primary action · the data shown · the four states · who can do what.
3. **Compose** from `@/components/ui/*` and `@/components/patterns/*`. Inventory and props: [references/components.md](references/components.md).
4. **Fill the states** (populated, empty, loading, error) with real domain copy. Rules: [references/states-and-copy.md](references/states-and-copy.md).
5. **Check:** the edit hook runs `ui-guard` on every file you touch. Fix its errors immediately. Then run `pnpm check`.
6. **Look at it.** `pnpm dev` (port 3100), then Playwright screenshots at 1440×900 and 390×844, dark and light. Read every screenshot and compare against `/design`. Fix overlap, misalignment, truncation, weak contrast, and anything that looks like a template.
7. **Report honestly:** what you verified visually, what passed checks, what you didn't verify.

## Decision tables

**Which surface?**

| Need | Use |
|---|---|
| Page background | `bg-background` (AppShell sets it) |
| A table, chart, form or list | `<Panel>` + `<PanelHeader>` (never a raw div with border) |
| Menu, popover, dialog, tooltip | the primitive (it applies `bg-popover shadow-overlay`) |
| Hover row / well | `bg-muted` |
| Selected / pressed | `bg-accent` |
| Input background | `bg-field` (Input does this) |

**Which ink?** `text-foreground` (primary) · `text-muted-foreground` (descriptions, secondary values) · `text-subtle-foreground` (metadata, column headers, placeholders). Never a fourth gray, never opacity on text.

**Which button?**

| Situation | Variant |
|---|---|
| The one main action of the view | `primary` (max one per view; it's inverted neutral, not teal) |
| Everything else | `secondary` (default) |
| Toolbars, row actions, "View all" | `ghost` |
| Irreversible, in a confirm dialog or danger zone | `destructive` |
| Destructive row action (Revoke, Remove) | `destructive-ghost` |
| Inline navigation in text | `link` |

Sizes: `sm` (28px, in tables and toolbars), `md` (32px, default), `lg` (36px, rare). Icon-only buttons use `size="icon"` and need `aria-label` and a `Tooltip`.

**Which color means what?**

| Token | Means | Never use for |
|---|---|---|
| `brand` / `brand-text` | focus, selection, links, live | buttons, headings, decoration, backgrounds |
| `success` | 2xx, healthy, connected, improving metric | "nice" accents |
| `warning` | 4xx, degraded, approaching limit, production env | general emphasis |
| `danger` | 5xx, failing, breached threshold, destructive | errors that are really validation (use `aria-invalid` + Field error) |
| `info` | neutral notices, staging env, versions | |
| `chart-1..8` | chart series in fixed order, tenant avatars | UI chrome |

## Hard rules (enforced by ui-guard and @shadcn/lint)

- No raw colors, inline styles or arbitrary values. Stock palette, shadow, radius and type classes don't exist in this theme (cleared in `globals.css`).
- Call sites may add only layout and spacing classes to a primitive. Different look → add a variant to the primitive and to `/design`.
- Icons only from `@/components/ui/icon` (Phosphor, RSC-safe). Add a new icon by re-exporting it there.
- Fonts are wired once in `layout.tsx`. Never import a font elsewhere.
- Formatting only via `@/lib/format` (`formatCount`, `formatDuration`, `formatPercent`, `formatDelta`, `formatTimestamp`, `formatRelative`, `formatBytes`).
- No gradients, glows, blur, emoji, `hover:scale`, `animate-bounce/ping/pulse`, `transition-all`, `font-bold`, ALL-CAPS tracked labels, `text-4xl`+.
- Suppression requires a reason: `// ui-guard-ignore <rule>: <why>`. "It looked better" is not a reason.

## Tenancy and permissions (every tenant-scoped screen)

- Pages live under `src/app/projects/[slug]/`. The layout provides `CapabilitiesProvider`; read permissions with `useCan(action)`, `<Gated action>` or `<Field editableBy>`. Action names come from `src/lib/capabilities.ts` (shared with OPA). Never check role names in components.
- Disable plus a reason by default; `mode="hide"` only for admin-only surfaces irrelevant to others; read-only (not disabled) for forms a viewer can see.
- Keep scope in the URL (`?env=&range=&tz=`). Label production. One system banner slot.
- Full rules and sources: [references/saas-patterns.md](references/saas-patterns.md).

## When you need something that doesn't exist

1. Check `/design`, `components/ui`, `components/patterns`, then the shadcn MCP / `@reui` registry.
2. Registry component: `pnpm dlx shadcn@latest add <name>` (or `@reui/<name>`), then **bring it onto Aperture**:
   - Replace icon imports with `@/components/ui/icon`.
   - Delete stock classes (`bg-black/50`, `shadow-lg`, `rounded-xl` on controls, `text-white`).
   - Map colors to our tokens, and use `shadow-control` / `shadow-overlay`.
   - Check that the sizes match the 28/32/36 scale.
3. Built from scratch: put it in `components/ui` (a primitive, takes variants) or `components/patterns` (composes primitives), add every state to `/design`, and run `pnpm check`.

## Reference files (read the one the task touches)

- [references/tokens.md](references/tokens.md): every token and scale, and how to change one safely
- [references/components.md](references/components.md): primitive and pattern inventory, props, composition recipes
- [references/states-and-copy.md](references/states-and-copy.md): empty/loading/error rules, microcopy, error formula, numbers and time
- [references/data-display.md](references/data-display.md): tables, KPIs, charts (validated palette, mark specs), timestamps
- [references/saas-patterns.md](references/saas-patterns.md): multi-tenant UX (switching, permissions, settings, API keys, banners, scope)
- [references/anti-slop.md](references/anti-slop.md): the tells of generated UI, what replaces each, and why the generic frontend-design advice is wrong here
- [references/motion-a11y.md](references/motion-a11y.md): motion, focus, keyboard, hit targets, reduced motion
