# Anti-slop: what makes UI look generated, and what to do instead

Generated UI looks generated because it is the **average of its training data**:
default shadcn + Tailwind palette + Inter + Lucide at 16px, decorated with
gradients and glows nobody asked for. A text-only prompt gets the average. This
project removes the average at the source (cleared scales, curated icons, tuned
tokens) and blocks the rest in `ui-guard`.

## Tells → replacements

| Tell | Instead | Enforced |
|---|---|---|
| Gradient backgrounds, gradient text, purple→indigo washes | solid tokenized surfaces; emphasis through type and layout | ui-guard `no-gradient` |
| Glows, halos, `backdrop-blur` glass, `shadow-2xl` | the five depth tokens only | ui-guard `no-glow`, scales cleared |
| Emoji as icons or bullets | Phosphor via `@/components/ui/icon` | ui-guard `no-emoji` |
| Lucide/heroicons at default stroke | curated Phosphor set | ui-guard + ESLint `no-restricted-imports` |
| Obvious-metaphor icons: a rocket for setup, sparkles for anything AI, a bolt for "fast", a shield for anything security | the icon that names the object or action (`KeyIcon` for API keys, `WarningIcon` for a breach); no icon when the label already says it; no icons added to every menu item for symmetry | review |
| Inter / Geist / Manrope / Poppins / Plus Jakarta | Plex Sans + Plex Mono, wired once | ui-guard `no-stock-font` |
| Italics for emphasis | one weight step up (`font-medium`). No italics anywhere in UI chrome | ui-guard `no-italic` |
| `rounded-2xl` on everything, one radius everywhere | nested radius scale (4/6/8/10), concentric when nested (tokens.md) | scale cleared |
| Cards for everything, nested cards, three-up icon+heading+text rows | one `Panel` per table/chart/form; lists and tables for collections | review |
| The rule of three: three tiles, three panels, three bullets, "fast, reliable and secure" | the count the data has. Two panels or four tiles is fine. Never invent a third item to fill a row, never trim a fourth to make a triad | review |
| Everything centered | left-aligned and anchored to the content edge. Center only the `EmptyState` / `ErrorState` block inside its panel | review |
| Siblings that don't line up (tile labels, values and sparklines at different heights; side-by-side panel headers of different heights) | siblings share one structure, so baselines align across the row | review |
| Big number + small label "hero metric" tiles with no context | `StatTile` with delta vs named period + trend, in a `StatRow` | review |
| ALL-CAPS tracked eyebrows, `A · B · C` meta strings everywhere, `→` on buttons | sentence-case labels in muted ink; verb + object buttons | ui-guard `no-template-chrome` |
| Colored side-stripe borders on cards | a `Badge` or `StatusDot` with a word | ui-guard `no-template-chrome` |
| Status dots that map to no state, badge spam | badges only for defined states, ≤1 per row | review |
| Hover lift/scale on cards, page-load fade-up choreography, bouncing, reveal-on-scroll | motion only confirms state changes, 100–200ms | ui-guard `no-attention-motion`, `no-scroll-listener` |
| "Welcome back, Neel!" greeting hero, centered hero inside the app | a `PageHeader` whose title is the noun the page is about | ui-guard `no-generic-copy` |
| Buzzwords and hype verbs (seamless, delve, unleash, empower, supercharge, cutting-edge), exclamation marks, "Oops" | the plain verb for what the product does ("records", "groups", "alerts"); exact, calm copy (states-and-copy.md) | ui-guard `no-generic-copy` |
| "Learn more", "Read more", "Get started", "Submit" | name the destination or outcome: "View setup guide", "Create project", "Save changes" | ui-guard `no-vague-label` |
| Em dashes in sentences ("Fast — and reliable") | a period, comma or colon. The em dash is a data glyph here: it means "no value" (`<Empty/>`) | ui-guard `no-em-dash-prose` |
| Lorem ipsum, "John Doe", "Item 1" | real domain data (`src/lib/demo-data.ts` style) | ui-guard `no-placeholder-copy` |
| Round, too-clean numbers in demo data (1,000 requests, 50 ms, 99.9%, every timestamp on the hour) | uneven, plausible values with real skew: 7,311 requests, p95 182 ms, 0.37% errors; a few endpoints carry most traffic; p99 several times p50 | review |
| Invented proof: uptime percentages, customer counts, SOC 2 badges, testimonials, star ratings | real figures with a source, or leave the section out | review |
| Mono as a costume | mono only for code, ids, paths, keys, methods | review |
| Random hex, arbitrary values, inline styles | tokens and scales | ui-guard + @shadcn/lint |
| `h-screen` / `100vh` | `min-h-dvh` / `h-dvh`, so nothing jumps when mobile browser chrome shows or hides | ui-guard `no-vh-unit` |
| `z-[9999]` and z-index arms races | the layering ladder in tokens.md; feature code needs no z-index | ui-guard `no-arbitrary-value` |
| Teal (cyan-on-dark) everywhere | brand ≤ ~5% of pixels: focus, selection, links, live. Never with a second "tech" hue (purple, neon) | review |

## What makes it feel crafted (keep doing this)

- Controls with real depth: inset hairline, top highlight, bottom edge (`shadow-control*`).
- **One light source, from above.** Highlights sit on top edges and shadows fall below, on every surface. All five shadow tokens obey this; a new one must too.
- **One temperature.** Neutrals are cool, tinted toward the brand hue (235). Never mix in a warm gray or a beige surface. One accent (teal), spent on meaning.
- Three inks, surfaces stepping up in lightness.
- Concentric radii: a nested element's radius is its container's radius minus the gap between them.
- Tabular numbers that align, units with no-break spaces, true minus signs, em dash for missing.
- Headings wrap balanced (set globally on h1–h3); multi-line descriptions and state copy use `text-pretty` so no word sits alone on the last line.
- Exact copy that names the thing: "/v1/payments/charge returned 502", not "An error occurred".
- Density with rhythm: tight inside groups, generous between them.
- Product-specific signature components (trace waterfall, live odometer, flow map) carry the personality, not decoration.

## Defaults vs decisions

The real tell isn't any single choice. It's a choice nobody made. A design
system applied mechanically drifts generic too, so the goal is not zero
exceptions; it's zero unexamined defaults.

- You may break a rule when the content demands it (a chart that genuinely needs a fifth series hue, a table that needs a sixth column). State the reason in one sentence tied to the product or the data, in code (`ui-guard-ignore <rule>: <reason>`) or in your report. "Bar width is data-driven" is a reason. "It looked better" isn't.
- If the same exception comes up twice, it isn't an exception. Propose a variant or token instead, and add it to `/design`.
- Before reaching for any value, ask whether you picked it or it came with the tool. If it came with the tool, check it against the system.

## Why not the generic `frontend-design` skill here

Anthropic's `frontend-design` skill (rewritten 2026-09-03) is good for marketing
pages and one-off artifacts. For a product dashboard it points the wrong way:

- It frames the agent as a design studio taking aesthetic risk; product UI should "disappear into the task". Consistency beats surprise.
- It asks for distinctive display typefaces and a memorable hero; an app screen has no hero, and display faces in labels are a violation.
- It allows one orchestrated page-load moment; here, no load choreography.
- It flags mono data labels and dense meta rows as tells; in an API tool they're correct when they carry real data.

Keep its good parts: visual structure is information, motion answers user
actions, errors never apologize or stay vague, empty screens invite the next
action. Don't install it in this folder.

## Generic "stop looking AI-generated" checklists

Articles like Design Bootcamp's "How to stop your frontend looking
AI-generated" (read 2026-10-22) are mostly right about tells, and their
mechanical rules are folded into the table above and into `/ui-audit` (review by
domain, evidence for every finding, group by root cause, zero findings allowed).
They're written for marketing sites, though. These parts don't apply here:

- **"Switch to Manrope or Geist."** Those are the new defaults; both are banned by `no-stock-font`. Plex stays.
- **Grain textures, layered imagery and tinted photos for depth.** Decoration. App depth is the five shadow tokens.
- **Bento grids and alternating image/text splits** instead of three-card rows. Marketing layouts. App layout is `PageHeader` → `StatRow` → `Panel`s, sized by the data.
- **A contrasting display + body font pair.** One superfamily (Plex Sans + Mono) is the point.
- **Stock photography and "imperfect" generated art.** The app has neither. Docs screenshots are real product.
