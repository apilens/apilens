---
version: alpha
name: Aperture
description: APILens product UI. Dark-first, dense, calm developer tooling with a single teal signal color.
colors:
  primary: "#44c9bc"
  on-primary: "#071413"
  background: "#0b0e0f"
  surface: "#111417"
  surface-raised: "#161a1d"
  surface-hover: "#181c1f"
  surface-selected: "#202528"
  field: "#0e1113"
  on-surface: "#eef1f2"
  on-surface-secondary: "#acb2b5"
  on-surface-tertiary: "#878d91"
  link: "#5bd5c8"
  border: "#ffffff16"
  border-input: "#ffffff26"
  action: "#eef1f2"
  on-action: "#0e1215"
  destructive: "#d33b36"
  on-destructive: "#ffffff"
  success: "#5ccb89"
  warning: "#f5bd56"
  danger: "#f66d67"
  info: "#6cb2ec"
typography:
  hero-figure:
    fontFamily: IBM Plex Sans
    fontSize: 32px
    fontWeight: 600
    lineHeight: 40px
    letterSpacing: -0.02em
  stat-value:
    fontFamily: IBM Plex Sans
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.015em
  page-title:
    fontFamily: IBM Plex Sans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.01em
  section-title:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px
  body:
    fontFamily: IBM Plex Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22px
  ui:
    fontFamily: IBM Plex Sans
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  ui-strong:
    fontFamily: IBM Plex Sans
    fontSize: 13px
    fontWeight: 500
    lineHeight: 20px
  caption:
    fontFamily: IBM Plex Sans
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  micro:
    fontFamily: IBM Plex Sans
    fontSize: 11px
    fontWeight: 500
    lineHeight: 16px
  code:
    fontFamily: IBM Plex Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 10px
  full: 9999px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "6": 24px
  "8": 32px
components:
  page:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.ui}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 16px
  panel-description:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-tertiary}"
    typography: "{typography.caption}"
  menu:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 4px
  table-row-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.on-surface}"
    height: 36px
  table-row-selected:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.on-surface}"
    height: 36px
  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-tertiary}"
    typography: "{typography.caption}"
    height: 32px
  secondary-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-secondary}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.on-surface}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 10px
  input-border:
    backgroundColor: "{colors.border-input}"
  divider:
    backgroundColor: "{colors.border}"
  link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.link}"
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 12px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 12px
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-destructive}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 12px
  brand-fill:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  badge:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.on-surface-secondary}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    height: 20px
  status-success:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.success}"
  status-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
  status-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
  status-info:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.info}"
  stat-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.stat-value}"
    padding: 16px
  hero:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.hero-figure}"
  page-heading:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.page-title}"
  dialog-title:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.section-title}"
    rounded: "{rounded.xl}"
  prose:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface-secondary}"
    typography: "{typography.body}"
  code:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
  avatar:
    rounded: "{rounded.full}"
---

## Overview

Aperture is the product UI of APILens, an API observability tool used by engineers
during incidents and daily triage. The interface should feel like a precise
instrument: calm, dense, fast to scan, trustworthy with numbers. It is dark-first
(engineers live in dark editors and terminals) with a complete light theme.

Personality comes from precision, not decoration: tuned neutrals, controls with
real depth, aligned tabular numbers, exact copy. There is one signal color (teal)
and it is spent only on focus, selection, links and "live". Everything that looks
like a template (gradients, glows, emoji, hero sections, card grids) is out.

The source of truth is `src/styles/tokens.css`; the YAML above is generated from
it. The living reference is `/design` in the running app.

## Colors

- **Surfaces step up in lightness with elevation:** background (page) → surface (panels, tables) → surface-raised (menus, dialogs) → surface-hover (hover rows) → surface-selected (pressed and selected). On dark, elevation is lightness, not shadow.
- **Neutrals are tinted** toward hue 235 (cool blue-gray) so they sit with the teal, instead of stock zinc.
- **Text has three inks:** on-surface (primary, ≥15:1), on-surface-secondary (descriptions, ≥7.9:1), on-surface-tertiary (metadata and placeholders, ≥5:1). No fourth gray.
- **Primary action is inverted neutral** (`action` / `on-action`: near-white on dark, near-black on light), not teal. Teal (`primary`) is focus, selection, links and live state, under ~5% of pixels.
- **Status colors carry state only:** success = 2xx/healthy, warning = 4xx/degraded, danger = 5xx/failing, info = neutral notices. They always pair with a word or icon.
- **Charts** use an 8-slot categorical palette validated for color-vision deficiency (tokens `--ap-chart-1..8`, fixed order, never cycled), a single-hue sequential ramp, and gray for context series. In light mode slots 3–5 sit below 3:1 on white, so those charts need direct labels or a table view.
- Every text/surface pair in both themes is checked by `pnpm ui:contrast`.

## Typography

IBM Plex Sans for UI and IBM Plex Mono for anything a user copies or compares
(paths, ids, keys, methods, code). Plex was chosen because its digits are
equal-width (columns align) and the mono is a true sibling, not because it's novel.

- Dense UI default is 13px (`ui`); prose and descriptions 14px (`body`).
- Scale ratio ~1.2: 11 / 12 / 13 / 14 / 16 / 20 / 24 / 32. Nothing below 11px.
- Weights 400, 500, 600 only. Hierarchy comes from size and ink, not heavy weight.
- Sentence case everywhere: titles, buttons, column headers, menu items.
- Numbers: right-aligned with `tabular-nums` in tables, proportional for big standalone figures. Number and unit are joined by a no-break space ("182 ms").

## Layout

- App shell: 240px sidebar (project switcher, nav), 48px top bar (search, theme), content max 1280px with 24px gutters, left-aligned. No centered heroes inside the app.
- Page anatomy: `PageHeader` (title is a noun, actions right: filters → time range → primary) → optional `StatRow` → `Panel`s. One panel holds one table, chart or form.
- Spacing is the 4px scale (4, 8, 12, 16, 24, 32). Tight inside groups, generous between them.
- Density: controls 28/32/36px, table rows 36px, inputs 32px. Value per pixel matters; empty space must be doing grouping work.
- Below 768px the sidebar collapses into a menu that still shows the active project. Tables scroll horizontally.

## Elevation & Depth

DESIGN.md has no shadow tokens, so depth is described here and implemented as
`--ap-shadow-*` in tokens.css:

- **panel:** hairline border plus a 1px top inner highlight on dark (a faint drop on light).
- **control:** inset 1px hairline drawn as a shadow, top highlight, soft bottom edge. This is what makes buttons read as pressable objects rather than flat rectangles.
- **control-primary / control-destructive:** the same recipe tuned for filled controls.
- **overlay:** menus, dialogs and tooltips only: hairline ring plus a large soft drop.

Nothing else gets a shadow. No glows, no blur, no glass.

## Shapes

Radii are small and nest: badges and kbd 4px, controls 6px, panels and menus 8px,
dialogs 10px. A child never has a larger radius than its container. Full rounding
is only for avatars, dots and switch tracks.

## Components

All components live in `src/components/ui` (primitives) and
`src/components/patterns` (app patterns), and all appear in `/design`.

- **Button:** primary (inverted neutral, one per view), secondary (default), ghost, destructive, destructive-ghost, link. Loading keeps the label and adds a spinner.
- **Field + Input:** label, hint or error wired with aria; `mono` for identifiers; `editableBy` makes fields read-only with a reason for users without permission.
- **Panel:** the only container. `PanelHeader` = title + description + actions.
- **Table:** 36px rows, hairline dividers, no zebra, sentence-case headers, numeric columns right-aligned, `tone` for threshold breaches, em dash for missing values.
- **Badge / StatusDot / EnvBadge / LiveIndicator:** state only, always with words.
- **StatTile / StatRow:** label, value, delta against a named period (colored by whether up is good), 12-point sparkline. A KPI row is one panel divided by hairlines.
- **Tenancy:** ProjectSwitcher (keeps the current section across projects), TenantAvatar (stable distinct mark per project), Gated (disable + reason, or hide), DangerZone (type the slug to confirm), Banner (one system banner slot).
- **States:** EmptyState, ErrorState, TableSkeleton.

## Do's and Don'ts

- Do compose from existing components; don't restyle them at the call site.
- Do use color only for meaning; don't use teal as decoration or for primary buttons.
- Do write exact copy ("Couldn't load endpoints. Retry."); don't write "Oops! Something went wrong".
- Do show every state; don't leave a panel blank or spin a full-page loader for one panel.
- Do keep the active project and environment visible; don't let an action happen in an unlabeled context.
- Don't use gradients, glows, blur, emoji, hover-lift, bouncing or pulsing decoration, ALL-CAPS eyebrows, three-card feature rows, or a greeting hero.
- Don't add a font, an icon set or a color. Each is a design decision that goes through tokens and `/design`.
