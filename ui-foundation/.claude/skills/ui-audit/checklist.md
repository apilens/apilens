# Aperture review checklist

Yes = pass. Items marked (auto) are already covered by ui-guard or ESLint;
confirm they ran rather than re-checking by eye.

## A. Does it read as designed?

1. With the logo covered, does the page still look like a serious API observability product, not a template?
2. Is the title the noun the page is about (no greeting, no centered hero)?
3. Is there at most one primary (inverted) button in the view?
4. Is hierarchy carried by size and ink (three inks), not by color or heavy weight?
5. Is brand teal limited to focus, selection, links and live state (≤ ~5% of pixels)?
6. Is every container a `Panel` (no nested panels, no row of identical icon+heading+text cards)?
7. Are there no gradients, glows, blur, emoji, ALL-CAPS eyebrows, side-stripe borders, or decorative badges? (auto)
8. Does it match `/design` for spacing rhythm, radius nesting, and control heights?

## B. Data

9. Are numbers right-aligned with tabular figures in tables, and identifiers in mono?
10. Is every value formatted via `lib/format`, with units, no-break spaces, ≤2 decimals and a true minus? (partly auto)
11. Do missing values render as `<Empty/>`, and is zero visually distinct from no data?
12. Does every KPI tile have a delta against a named period and real history?
13. Do charts follow the form-first rule, fixed series order, one y-axis, legend for ≥2 series, and units, range and timezone shown?
14. Do threshold breaches use cell `tone`, keeping the number as the information?

## C. States and copy

15. Are all four states present: populated, empty (first use and no results), loading (skeleton shaped like the content), error?
16. Does the error state say what failed, what to do, and show a request id, without pretending to be empty?
17. Is everything in sentence case, with buttons as verb + object?
18. Is there no "Oops", "Something went wrong", "Welcome back", buzzwords, exclamation marks or placeholder data? (partly auto)
19. Do validation errors sit under their field and say how to fix them?
20. Is feedback inline next to the change, with toasts only for off-screen, non-critical results?

## D. Tenancy and permissions

21. Is the active project visible (switcher/avatar) and the environment labeled?
22. Is every gated action read through `useCan` / `Gated` / `Field editableBy` with an action from `capabilities.ts` (no role-name checks)?
23. Is disable vs hide vs read-only chosen per the rule, with a reason for each disabled control?
24. Do destructive actions follow the ladder (undo, then specific confirm, then type-the-slug), with buttons naming the outcome?
25. Is scope (env, range, tz) in the URL, and does switching projects keep the section?
26. Is there one system banner at most, in priority order?

## E. Interaction and accessibility

27. Does every control show a visible focus ring, with a logical tab order and nothing hidden under sticky headers?
28. Are actions `<Button>`, navigation `<Link>`, with no clickable divs? (auto)
29. Do icon-only buttons have `aria-label` and a tooltip?
30. Is status never shown by color alone?
31. Is there one `h1`, with `h2` for panels and no skipped levels?
32. Are transitions 100–200ms ease-out on color, opacity and transform only, with no load choreography or hover lift? (auto)
33. Is reduced motion respected?

## F. Layout robustness (visual)

34. At 1440: no awkward empty columns, nothing stretched edge to edge that shouldn't be?
35. At 390: no horizontal page scroll; tables scroll inside their panel; header actions wrap cleanly?
36. Are long values (paths, names) truncated with the full value available, never overflowing?
37. Dark and light: is every surface, border and text legible, with no element vanishing in one theme?
38. Do loading → populated transitions avoid layout shift?
