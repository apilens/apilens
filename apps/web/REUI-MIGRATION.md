# ReUI migration guide (branch: reui-revamp)

APILens' web UI is being migrated from hand-rolled CSS classes (globals.css /
aperture.components.css) to **ReUI** — a shadcn-compatible component system.
The foundation is already in place; this document is the contract every
migrated surface must follow.

## Foundation (already done — do not redo)

- Base components live in `src/components/reui/*` (button, card, input, label,
  textarea, select, checkbox, switch, dialog, alert-dialog, dropdown-menu,
  popover, tooltip, tabs, table, separator, scroll-area, sheet, skeleton,
  avatar, command, sonner, alert, badge).
- `cn()` helper: `import { cn } from "@/lib/utils"`.
- Theme tokens: `src/styles/reui.tokens.css` bridges shadcn semantics to the
  existing Aperture palette. Dark/light switches via `[data-theme]`; the
  Tailwind `dark:` variant is wired to it.
- Reference implementations: `src/components/dashboard/Sidebar.tsx` and
  `Navbar.tsx`.

## Rules

1. **Re-skin, not refactor.** Keep all state, handlers, data fetching, routing,
   props and component boundaries exactly as they are. Only markup/classNames
   change.
2. **Semantic tokens only.** `bg-background`, `bg-card`, `bg-muted`,
   `bg-accent` (hover surface), `text-foreground`, `text-muted-foreground`,
   `border-border`, `text-primary` / `bg-primary` (teal), `text-destructive`,
   `text-success`, `text-warning`, `text-info`, `ring-ring`. Never hardcode
   hex colors; never use Tailwind palette colors (`bg-zinc-800` etc.).
3. **Component mapping:**
   - buttons → `Button` (variants `default | outline | ghost | destructive`,
     sizes; icon-only → `size="icon"`)
   - panels/cards → `Card`, `CardHeader`, `CardTitle`, `CardContent`, `CardFooter`
   - form fields → `Input`, `Label`, `Textarea`, `Select`, `Checkbox`, `Switch`
   - modals → `Dialog`; destructive confirms → `AlertDialog`
   - menus → `DropdownMenu`; hover hints → `Tooltip`; side panels → `Sheet`
   - tab strips → `Tabs`; data tables → `Table`; status pills/counters →
     `Badge` (has `variant` + `appearance` props); loading → `Skeleton`
4. **Visual language stays Aperture:** teal primary, 13px base text in dense
   surfaces, 8px radius, hairline borders. The page should look like the same
   product, just rebuilt on ReUI.
5. **Don't delete CSS.** Orphaned classes in globals.css get cleaned up later.
   Keep global layout-contract classes (`.main-content`, `.dashboard-container`,
   `.main-wrapper`, `.sidebar`, `.navbar`, `.settings-page`, `.ep-workspace`)
   where they gate layout in other files.
6. **Leave alone:** recharts internals, canvas/waterfall renderers,
   `components/aperture/Spotlight.tsx`, `LiveNumber`, providers, hooks, API
   routes.
7. When a piece of markup is too intricate to map confidently, keep the
   existing markup for that piece — a partial, correct migration beats a
   broken complete one.
8. Verify with `pnpm exec tsc --noEmit` (run from `apps/web`) before finishing.
