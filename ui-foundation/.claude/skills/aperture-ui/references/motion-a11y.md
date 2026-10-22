# Motion and accessibility

## Motion

- Motion confirms a state change the user caused (menu opened, row selected, value saved). It never decorates, never plays on page load, never loops except the `Live` dot and skeletons.
- Durations: 100ms hover/color, 150ms state, 200ms overlay in, 100ms overlay out, 300ms max. Curve: `ease-out` (token `cubic-bezier(0.2, 0, 0, 1)`).
- Animate `opacity` and `transform` (and colors); never layout (`width`, `height`, `top`). Use `transition`, `transition-colors`, `transition-opacity` or `transition-transform`, never `transition-all`.
- Responses under 100ms get no animation. Interruptible: no animation blocks input.
- Reduced motion: `globals.css` swaps overlay entrances to fades and stops the live dot and skeleton loops. Keep state feedback; don't kill everything.
- **Anything that moves or updates on its own for more than 5 s** (live polling, odometer numbers, auto-refreshing tables) has a visible Pause, and pausing stops both the motion and the refresh (WCAG 2.2.2). Show the state with `LiveIndicator paused`.
- No scroll listeners for visibility, lazy loading or "stuck" detection. Use `IntersectionObserver`. No reveal-on-scroll animation in the app at all.

## Layout robustness

- Full-height layouts use `min-h-dvh` / `h-dvh`, never `h-screen` or `100vh` (mobile browser chrome changes the viewport and `vh` jumps).
- Siblings in a row (tiles in a `StatRow`, side-by-side panels) share structure so their labels, values and headers line up. If one tile has no sparkline, it keeps the space.

## Focus and keyboard

- Every interactive element has the shared `focus-ring` (2px brand outline, 2px offset) or, for inputs, border + ring. Never remove an outline without a replacement.
- Actions are `<Button>`, navigation is `<Link>`. No `onClick` on `div`/`span`/`tr`.
- Dialogs trap and return focus (Radix does this); Escape closes overlays; menus are arrow-key navigable (Radix).
- Disabled controls that explain themselves (`Gated`) sit in a focusable wrapper so keyboard users get the reason too.
- Sticky headers must never cover the focused element (`scroll-mt-*` on anchors).
- Shortcuts: show them in menus (`DropdownMenuShortcut`) and tooltips (`Kbd`). ⌘K opens search.

## Semantics

- Landmarks: `AppShell` owns them. One banner (the top bar `<header>`), one `<main>`, labeled `<nav>`s (`aria-label="Project"`), and a footer, if any, as a sibling of `<main>` rather than inside it. Pages never render their own `<main>`. A `<header>` or `<footer>` inside a `Panel` is fine: inside `<main>` it isn't a landmark.
- One `h1` per page (`PageHeader`); `PanelHeader` titles are `h2`. Heading order never skips.
- Icon-only buttons have `aria-label`; decorative icons are `aria-hidden` (Phosphor SVGs inside labeled buttons are fine).
- Status is never color alone: dot + word, icon + word.
- Live regions: loading and validation use `role="status"` / `role="alert"`, once per group, not per skeleton row.
- Tables are real `<table>` elements with header cells. `sr-only` labels for icon-only columns.
- `<time dateTime>` for timestamps, with the absolute time in `title`.

## Targets and contrast

- Hit targets ≥ 24px on desktop (our smallest control is 28px), ≥ 44px for touch-primary surfaces.
- Text ≥ 4.5:1, primary text ≥ 7:1, icons, focus rings and chart marks ≥ 3:1. `pnpm ui:contrast` checks every token pair in both themes.
- Hover and focus states must raise contrast, never lower it.
- Check 200% zoom and a 1280px laptop as well as 1440 and 390.
