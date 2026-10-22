# States and copy

## The four states (every data surface)

| State | Component | Content rule |
|---|---|---|
| Populated | the real view | — |
| Empty: first use | `EmptyState` | what will appear here + the one action that makes it appear ("Install the SDK and send one request. It appears here within a few seconds." → "View setup guide") |
| Empty: no results | `EmptyState` | name the filter ("No 5xx responses in the last hour") + "Clear filters" |
| Loading | `TableSkeleton` / `Skeleton` | same row height and column rhythm as the real content; panel chrome stays |
| Error | `ErrorState` | what failed + what to do + request id; keep the last good data visible if you have it, marked stale |

- **Never show an empty state when the fetch failed.** It implies data loss.
- Loading timing: under ~1s show nothing (or keep previous data), 1–3s skeleton, over 10s move it to the background and notify. Delay showing loaders ~150–300ms so fast responses don't flash.
- Render each panel as its data arrives; never a full-page spinner for one panel.
- "No data" must look different from zero: `0` is a value, an em dash (`<Empty/>`) is absence.
- Feedback goes inline, next to the thing that changed. Toasts only for non-critical results that aren't visible on screen; critical errors never auto-dismiss.
- Destructive actions: undo for reversible ones; a specific-verb confirm for serious ones; type-the-slug plus a scheduled, cancellable deletion for irreversible ones (`DangerZone`).

## Voice

Plain, specific, calm. Second person, active voice. Engineers read this during
incidents: say the fact, then the next step.

- **Sentence case** for everything: titles, buttons, column headers, menu items, badges.
- **Buttons are verb + object:** "Create API key", "Revoke key", "Send test request". Not "Submit", "OK", "Yes". An action keeps its name through the flow (Revoke → "Revoke key" → "Key revoked").
- **Links name where they go:** "View setup guide", "Open trace", "See all 5xx responses". Never "Learn more", "Read more", "Get started" or "Click here".
- **Menu items that open a follow-up step end with an ellipsis character** ("Rename…"). So does progress text ("Saving…").
- **Cut:** paragraph → sentence → label → nothing. Panel descriptions are one line.
- **No em dashes in sentences.** Use a period, comma or colon. The em dash is reserved for missing values (`<Empty/>`).
- **No rule of three.** Don't stack adjectives or list three benefits for rhythm ("fast, reliable and secure"). One specific, true claim beats three generic ones.
- **Emphasis is a weight step** (`font-medium`), never italics, never bold.
- **No:** "Oops", "Whoops", "Something went wrong", "Welcome back", "Let's get started", exclamation marks, emoji, "simply", "just", buzzwords and hype verbs (seamless, supercharge, unlock, elevate, effortless, powerful, delve, unleash, empower, robust, cutting-edge, game-changing).

## Error formula

**What happened + why (if known) + what to do**, then a reference id.

| Bad | Good |
|---|---|
| Something went wrong. | Couldn't load endpoints. The analytics service timed out after 10 s. Retry in a moment. |
| Invalid input. | Enter a value between 1 and 60,000 ms. |
| Error 403 | Only admins can create API keys. Ask an admin for access. |
| Failed to save | Couldn't save project name: "checkout api" contains a space. Use letters, numbers and hyphens. |

Validation errors sit under the field (`Field error`), appear after the user
leaves the field or submits, and focus moves to the first invalid field on submit.

## Numbers, units, time

- Always format through `@/lib/format`. Number and unit are joined by a no-break space ("182 ms", "1.2 MB").
- Counts: exact below 10,000 ("7,311"), compact above ("182.4K"); show the exact value in a tooltip or table where precision matters.
- Percent: at most 2 decimals; `<0.01%` instead of `0.00%`.
- Deltas: signed with a true minus ("−3.1%"), always against a named period ("vs previous 24h").
- Time: relative under 30 days ("12s ago") in a `<time>` with an absolute `title` (`formatTimestamp`, explicit zone); absolute beyond. Say which zone charts and pickers use.
- Durations auto-scale µs → ms → s → "2m 05s".

## Demo and fixture data

Fake data is copy too, and round numbers are a tell. It should look measured, not invented.

- Uneven values: 7,311 requests, p95 182 ms, 0.37% errors. Not 1,000 / 50 ms / 99.9% / 5%.
- Real skew: a few endpoints carry most of the traffic, p99 sits several times above p50, error rates differ by endpoint, one consumer dominates.
- Timestamps spread naturally (not all on the hour), recent activity denser than old.
- Names come from the domain: `/v1/payments/charge`, `checkout-api`, `partner-sync`, `apl_live_7f3k…`. No "Acme", "Test project", "Endpoint 1".
- Never invent proof (uptime %, customer counts, compliance badges, testimonials). Show real figures with a source or leave the element out.
