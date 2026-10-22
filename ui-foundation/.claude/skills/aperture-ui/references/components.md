# Components

Everything below is rendered in every state at `/design`. If a component isn't
there, it doesn't exist yet. Add it there when you create it.

## Primitives: `@/components/ui/*`

| Component | Props / variants | Rules |
|---|---|---|
| `Button` | `variant`: primary · secondary (default) · ghost · destructive · destructive-ghost · link; `size`: sm · md · lg · icon-sm · icon; `loading`; `asChild` | one `primary` per view; icon-only needs `aria-label` + `Tooltip`; wrap links with `asChild` + `<Link>` |
| `Input` | `mono` | always inside `Field` |
| `Field` | `label`, `hint`, `error`, `editableBy` | wires id / aria-describedby / aria-invalid; `editableBy` → read-only + reason |
| `Label` | | Field uses it; standalone only next to `Switch` |
| `Switch` | Radix props | label it with a wrapping `<label>`; toggles autosave, forms don't |
| `Panel`, `PanelHeader`, `PanelBody`, `PanelFooter` | `tone`: default · danger | the only container; header = title (+description, +actions) |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `Empty` | `numeric`, `mono`, `tone` (muted · warning · danger) | 36px rows, right-aligned numbers, `Empty` (em dash) for missing values |
| `Badge` | `tone`: neutral · brand · success · warning · danger · info; `dot`; `mono` | state or short attribute; ≤1 per row |
| `StatusDot` | `status`, `label` | the label is required |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Radix | views of the same object; not for navigation between objects |
| `DropdownMenu*` | `DropdownMenuItem destructive`, `RadioItem`, `Label`, `Separator`, `Shortcut` | menus for actions and single-select pickers |
| `Dialog*` | `DialogContent/Header/Title/Description/Body/Footer/Close` | last resort for focused tasks; row details go in a page or side panel |
| `Tooltip` (+ `TooltipProvider` in layout) | `content`, `side` | explains a control or a disabled reason; never the only place information lives |
| `Skeleton` | | shaped like the content it replaces |
| `Spinner` | `label` | pending actions only (Button `loading` uses it) |
| `Kbd` | | shortcuts |
| `Separator` | `orientation` | prefer `divide-y divide-border` on lists |
| icons (`@/components/ui/icon`) | Phosphor `*Icon`, `weight` | 16px (`size-4`), 14px in sm controls; `weight="fill"` only for active nav |

## Patterns: `@/components/patterns/*`

| Pattern | Use |
|---|---|
| `AppShell` | every tenant page (sidebar + top bar + content + one banner slot); provided by `projects/[slug]/layout.tsx` |
| `ProjectSwitcher`, `MobileNav`, `SidebarNav` (`NAV_ITEMS`) | tenant switching and navigation; switcher keeps the current section |
| `TenantAvatar` | stable distinct mark per project (initials on a chart-palette wash) |
| `PageHeader` | `title` (a noun), `description`, `meta` (EnvBadge, LiveIndicator), `actions` (filters → range → primary) |
| `StatRow` + `StatTile` | KPI row: label, value (pre-formatted), `delta` + `upIsGood` + `period`, `trend` |
| `Sparkline` | 12-point trend inside tiles and table rows |
| `TimeRangePicker` | the one global time range (top right) |
| `EnvBadge`, `LiveIndicator` | where the data is from; whether it's streaming |
| `Gated` | permission-aware control: `action`, `mode` disable (default) or hide |
| `DangerZone` | bottom of settings; type-the-slug confirmation |
| `Banner` | system state above the top bar: support access, read-only, degraded ingestion |
| `EmptyState`, `ErrorState`, `TableSkeleton` | the non-populated states |
| `ThemeToggle` | top bar |

## Composition recipes

**Dashboard page**
```tsx
<PageHeader title="Traffic" description="…" meta={<EnvBadge env="production" />} actions={<TimeRangePicker />} />
<StatRow className="mb-6">{/* 3–4 StatTiles, each with delta + period */}</StatRow>
<Panel className="mb-6"><PanelHeader title="…" description="…" actions={<Button variant="ghost" size="sm">…</Button>} />
  <Table>…</Table>
</Panel>
<div className="grid gap-6 lg:grid-cols-2">{/* two related panels */}</div>
```

**Settings page:** `PageHeader` → `Tabs` (General | Members | API keys | Billing) → `Panel` with `PanelBody` grid of `Field`s and a `PanelFooter` with one gated primary "Save changes" → `DangerZone` last. Explicit save for forms, autosave for toggles; never mix them in one panel.

**Table row actions:** last column, right-aligned, `size="sm"` ghost buttons or one `DotsThreeIcon` menu (`aria-label="<Row> actions"`). Show them always (or on hover and keyboard focus); never hide-only-on-hover.

## Making or changing a primitive

- Variants via `cva`; the call site picks a variant and never overrides color, typography, shape or motion.
- Interactive elements get `focus-ring`, hover/active/disabled states, and `data-[state=open]` styling if they trigger menus.
- Update `/design` with every variant and state, then run `pnpm check`.
