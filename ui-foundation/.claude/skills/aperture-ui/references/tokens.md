# Tokens

Source of truth: `src/styles/tokens.css` (raw values, both themes) →
`src/app/globals.css` (`@theme inline` maps them to Tailwind utilities).
`DESIGN.md` front matter is generated from tokens.css (`pnpm design:sync`).

## Color utilities

| Utility | Token | Use |
|---|---|---|
| `bg-background` | `--ap-background` | page canvas |
| `bg-card` | `--ap-card` | panels, tables, KPI rows |
| `bg-popover` | `--ap-popover` | menus, dialogs, tooltips |
| `bg-muted` | `--ap-muted` | hover rows, wells, footers (`bg-muted/40`) |
| `bg-accent` | `--ap-accent` | selected / pressed / active nav item, skeleton blocks |
| `bg-field` | `--ap-field` | inputs |
| `text-foreground` | `--ap-foreground` | primary text |
| `text-muted-foreground` | `--ap-muted-foreground` | secondary text |
| `text-subtle-foreground` | `--ap-subtle-foreground` | tertiary: metadata, headers, placeholders, icons at rest |
| `border-border` | `--ap-border` | hairlines (default border color, so plain `border` works) |
| `border-input` | `--ap-input` | input borders |
| `ring-ring` | `--ap-ring` | input focus ring (brand at 30–35%) |
| `bg-primary` / `text-primary-foreground` | inverted neutral | primary button only |
| `bg-brand` / `text-brand-text` / `text-brand-foreground` | teal | focus, selection, links, live |
| `text-success|warning|danger|info` (+ `/10` washes, `/25` borders) | status | state only |
| `bg-destructive` / `text-destructive-foreground` | solid red | destructive button only |
| `bg-chart-1..8`, `stroke-chart-*`, `fill-chart-*` | categorical | chart series, tenant avatars |
| `stroke-chart-grid`, `stroke-chart-axis` | | chart chrome |

Opacity modifiers are fine on status and brand washes (`bg-danger/10`, `border-brand/25`).
Don't put opacity on text to make a new gray. Use the three inks.

## Scales (stock Tailwind scales are cleared)

| Scale | Values | Notes |
|---|---|---|
| `text-*` | 2xs 11 · xs 12 · sm 13 · base 14 · lg 16 · xl 20 · 2xl 24 · 3xl 32 | line-heights and tracking built in |
| `rounded-*` | sm 4 · md 6 · lg 8 · xl 10 · full | controls md, panels/menus lg, dialogs xl; nested radii are concentric (below) |
| `shadow-*` | panel · control · control-primary · control-destructive · overlay | nothing else exists |
| spacing (`p-`, `m-`, `gap-`) | 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24 | ×4px; others warn |
| `duration-*` | 100 hover · 150 state · 200 overlay · ≤300 | `ease-out` is the token curve |
| `animate-*` | skeleton · live · fade-in/out · overlay-in/out · spin (Spinner only) | reduced-motion aware |
| fonts | `font-sans` (Plex Sans) · `font-mono` (Plex Mono) | |
| weights | `font-normal` · `font-medium` · `font-semibold` | bold+ warns; emphasis is one step up (`font-medium`), never italics |
| text wrap | h1–h3 `text-wrap: balance` (global) · `text-pretty` | add `text-pretty` to multi-line descriptions and empty/error copy |
| z-index | `auto` · `z-40` · `z-50` | see Layering |

## Depth recipe

`shadow-control` = inset 1px hairline + top highlight + soft bottom edge. It's the
detail that makes controls read as made (the "Plume" quality), and it's tuned
separately per theme. On dark, highlights carry depth because drop shadows
don't show. Never stack another border on a `shadow-control` element.

There is **one light source, from above**: highlights on top edges, shadows
falling below, the same on every surface. A new shadow token follows the same
direction, or the UI reads as assembled from different kits.

## Concentric radius

When a rounded element sits inside another, **inner radius = outer radius − the
gap between their edges**, snapped to the nearest scale step. A `rounded-xl`
(10px) dialog with a 4px inset holds `rounded-md` (6px) controls; a `rounded-lg`
(8px) container with `p-1` (4px) holds `rounded-sm` (4px) items. When the gap is
as large as the outer radius or larger (a panel's 16px padding), the inner
element just uses its own scale step. A child is never rounder than its parent.

## Layering (z-index)

| Layer | Value | Who sets it |
|---|---|---|
| page content | `auto` (no z-index) | nobody |
| sticky top bar | `z-40` | `AppShell` (and the `/design` header) |
| overlays: menus, popovers, tooltips, dialogs, sheets | `z-50` | the primitives (Radix portals) |

Feature code needs no z-index. If something seems to, an ancestor created a
stacking context (`transform`, `filter`, `overflow`, `isolation`); fix that
instead. Never `z-[999]` (it's also an arbitrary value).

## Changing or adding a token

A token change is a design decision, not a fix.

1. Edit both theme blocks in `tokens.css` (dark under `:root, [data-theme="dark"]`, light under `[data-theme="light"]`).
2. New semantic token: also map it in `globals.css` `@theme inline` (`--color-x: var(--ap-x)`), add a contrast pair in `scripts/check-contrast.mjs`, and add a swatch to `/design`.
3. Run `pnpm ui:contrast` (text ≥4.5:1, primary ≥7:1, marks ≥3:1) and `pnpm design:sync`.
4. Look at `/design` in both themes before and after.
5. Chart colors: re-validate with the dataviz validator (adjacent CVD ΔE ≥ 8, normal-vision ΔE ≥ 15) against `--ap-card` in each theme.
