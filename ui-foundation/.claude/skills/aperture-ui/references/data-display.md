# Data display

## Tables

- Text left, numbers right (`numeric`), header aligned with its column. Never center.
- 36px rows, hairline dividers, no zebra stripes, no vertical rules. Header row doesn't hover.
- Identifiers (paths, ids, keys, methods) in mono (`TableCell mono` or `font-mono text-xs` inside a cell). Mono is never decoration.
- Missing value → `<Empty/>` (muted em dash). Never blank, "N/A", "null", "undefined", "NaN".
- Threshold breaches → `tone="warning" | "danger"` on the cell. The number stays the information.
- Truncate long values with `truncate` and full value on hover; offer copy for ids.
- Default sort is meaningful (by requests, by p95) and stated in the panel description.
- Beyond ~50 rows: paginate or virtualize. Sticky header when the table scrolls inside a panel.
- Bulk actions appear only after selection; row actions are always reachable by keyboard.

## KPIs

- `StatRow` of 3–4 `StatTile`s, one panel divided by hairlines, never floating cards.
- Each tile has a unit, a delta against a **named** period, and real recent history (sparkline). Without delta and history, it's the "hero-metric" template tell. Make it a table cell instead.
- `upIsGood` decides color: requests up = good; errors and latency up = bad. Zero delta is neutral.
- Large standalone figures use proportional figures (default); columns, axes and live-updating numbers use `tabular-nums`.
- At most one hero figure (`text-3xl`) per view.

## Charts

Follow the dataviz method: **pick the form first, color last.**

| The data's job | Form |
|---|---|
| one current value (+ trend) | StatTile, not a chart |
| trend over time, one series | line (2px) or area (series hue at ~10% opacity) |
| a few series that ARE the subject | multi-line, categorical slots 1..N |
| one series matters, rest is context | emphasis: brand/`chart-1` for the focus series, `subtle-foreground` gray for the rest |
| status over time (2xx/4xx/5xx) | stacked bars with **status** tokens (success/warning/danger), never categorical |
| magnitude across a grid | heatmap, single-hue sequential ramp |

- **Categorical palette:** `chart-1..8`, assigned in order, never cycled, color follows the entity (filtering never repaints survivors). Past 8 series → fold into "Other" or facet. Scatter-like forms cap at 3 series.
- **Light mode:** slots 3, 4 and 5 are below 3:1 on white. Charts using them need direct labels or a table view.
- **Marks:** bars ≤24px thick, 4px rounded data-end, square at the baseline, 2px surface gap between touching bars and segments; lines 2px with round joins; markers ≥8px with a 2px surface ring; gridlines 1px solid `chart-grid`, recessive.
- **One y-axis.** Never dual-axis; two measures → two charts.
- **Text never wears series color.** Labels, values and legends use text inks; a swatch or line-key beside them carries identity.
- Legend whenever there are ≥2 series; label selectively (the endpoint, the extreme). Never a number on every point.
- Always show the unit, the time range and the timezone. Tooltip on hover (crosshair for lines), with values in `tabular-nums`.
- Gaps in data render as gaps, not as zero.
- Before adding a new chart color: run the validator (`node <dataviz>/scripts/validate_palette.js "<hexes>" --mode dark --surface <card hex>`) and fix every FAIL.

## Observability scope

- One global time range per page (`TimeRangePicker`). Relative ranges ("Last hour") slide; fixed ranges don't. Live is explicit, with a Pause.
- Scope lives in the URL: `?env=production&range=24h&tz=utc`. Shared links reproduce the view.
- Environment is always labeled (`EnvBadge`), production most of all.
