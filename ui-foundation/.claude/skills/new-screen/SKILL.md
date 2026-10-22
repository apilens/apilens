---
name: new-screen
description: Build a new APILens screen end to end with the Aperture system. Steps are spec, reference, compose, all four states, permissions, checks, and visual verification in both themes and widths. Use when the user runs /new-screen.
argument-hint: "<what the screen is for, e.g. 'consumers list with per-consumer error rates'>"
disable-model-invocation: true
---

# /new-screen

Screen to build: **$ARGUMENTS**

Follow the `aperture-ui` skill throughout; read its references when a step touches them.

## 1. Spec (write it in your reply before coding, keep it to ~8 lines)

- **Object:** the noun this page is about. It becomes the `PageHeader` title.
- **Route:** `src/app/projects/[slug]/<section>/page.tsx` (tenant-scoped) or explain why not.
- **Primary action:** exactly one, or none.
- **Data:** what's shown and the default sort. Which values are counts, rates, durations or timestamps (→ `lib/format`).
- **Scope:** time range? environment? Which URL params hold them?
- **States:** what empty (first use and no results), loading and error say.
- **Permissions:** which actions are gated (`lib/capabilities.ts`); disable, hide or read-only for each.

If the request is ambiguous on something that changes the layout (e.g. table vs chart), pick the option consistent with existing screens and state the assumption.

## 2. Reference

Open `src/app/design/page.tsx` and the most similar existing screen. Name which one you're following and copy its structure.

## 3. Build

- Server component page; extract client components only for interaction.
- Compose from `components/ui` + `components/patterns`. If something is missing, add it as a primitive or pattern, add it to `/design`, then use it.
- Demo data goes next to `src/lib/demo-data.ts`, realistic and domain-specific.
- Add the route to `NAV_ITEMS` only if it's a top-level section.

## 4. Check

Run `pnpm check` and fix everything. The edit hook already blocked ui-guard errors, so warnings remain: fix them or justify each one in your report.

## 5. Verify visually (required)

1. `pnpm dev` (port 3100) if it isn't running.
2. With Playwright MCP, screenshot the new route at **1440×900** and **390×844**, in **dark** and **light** (set `localStorage.theme` then reload). Also check one state other than populated (temporarily render the empty or error state if needed).
3. Read each screenshot. Fix overlap, misalignment, clipped text, horizontal page scroll, weak hierarchy, and anything matching `references/anti-slop.md`.
4. Tab through the page once: focus visible on every control, logical order.

## 6. Report

- The spec, the files added or changed, and which existing screen you followed.
- What you verified visually (widths × themes × states) and what `pnpm check` returned.
- Anything you couldn't verify, and any new primitive or pattern you added to `/design`.
