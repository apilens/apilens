# Phase 5 — The Sentinel (alerting + anomaly detection) design

*Grounded in the 2026-07-18 competitor research pass (Sentry, Datadog/Watchdog,
Grafana/Alertmanager, Apitally, Honeycomb, Axiom, Slack API docs, Google SRE
workbook, Booking.com/Tinybird practitioner writeups). Research caveat: the
verification stage of that pass was cut short by a usage limit — claims come
from primary vendor docs but most carry single-source confidence.*

## What the field converges on

| Concern | Convergent practice | Source pattern |
|---|---|---|
| Rule families | **Issue-lifecycle alerts** (fire on state transitions: created, regressed) separate from **metric monitors** (thresholds over windows) | Sentry's exact split; its triggers are issue-state-based, not raw counts |
| State machine | `ok → pending → firing → resolved`, with a `for`-duration before firing and notifications ONLY on transitions plus a slow re-notify | Prometheus/Grafana (Normal→Pending→Alerting→Recovering); Axiom & Honeycomb notify on transitions, not evaluations |
| Anti-flap | Pending period before firing AND delayed resolve | Grafana `KeepFiringFor`; Apitally's *notify after triggered / notify after resolved* pair |
| Re-notify / cooldown | Off by default or slow: Alertmanager `repeat_interval` default **4h**; Datadog renotify optional with occurrence caps | Alertmanager defaults (group_wait 30s, group_interval 5m, repeat_interval 4h) |
| Threshold families | **Fixed** (absolute / % change) and **dynamic** (anomaly vs learned baseline band) as two modes of one monitor | Sentry metric monitors; Datadog anomaly monitors |
| Anomaly algorithms w/o ML infra | Robust stats: rolling **z-score ±2–3 sustained** (Tinybird), **same-time-of-previous-day/week percentile bands with history cleaned of past incidents** (Booking.com), MAD for outliers (Datadog `outliers()`); variance-scaled tolerance (Axiom) | Practitioners explicitly avoid ML; Datadog's own agile/robust need **≥3 seasonal cycles** of history (cold-start pitfall) |
| Low-traffic guard | Hard minimum-traffic gates: Watchdog monitors only endpoints with **≥0.5 req/s**; Google SRE: error-rate alerting breaks below ~10 req/h (one failure = 10%) | Explicit event-count floors, not cleverer math |
| Impact filter | Watchdog ignores throughput anomalies unless latency or error rate is also affected; "severe" needs ≥10 min duration | Alert on user-facing impact only |
| Evaluation | Scheduler loop; cadence scales with window (Datadog: 1-min eval for <24h windows; Honeycomb default 15m; Apitally window + "check every") | A periodic evaluator process, nothing streaming |
| Fan-out | Datadog Simple vs **Multi Alert** (one state per tag value, 60s new-group delay); Honeycomb GROUP BY triggers | Per-target state rows under one rule |
| Channels | Slack + email + generic webhook are the floor (Sentry's list adds Teams/Discord/PagerDuty/Jira) | Slack incoming webhook: `text` required, Blocks optional; 4xx errors must NOT be retried |
| Webhook retries | Retry 5xx/timeout/429 only, exponential backoff + jitter, honor Retry-After; never retry other 4xx | Webhook-delivery best-practice consensus |
| Muting | Rule disable + time-bounded snooze (silences); evaluation continues while muted | Alertmanager silences / mute_time_intervals |
| Known trap | A strict consecutive `for`-duration resets on any momentary dip, so severe-but-flapping incidents never fire | Google SRE workbook — mitigated below |

## APILens Sentinel design

### Two rule families (Sentry's split, our data)

**1. Issue rules** — event-driven, zero polling. The Phase-0 ingest upsert
already computes lifecycle transitions; it now also *emits signals*:

- Triggers: `new_issue` (first time a fingerprint is seen), `regression`
  (resolved → regressed — the transition Phase 4 verification makes
  meaningful).
- Delivery path: ingest INSERTs an **AlertSignal outbox row** in the same
  Postgres transaction as the issue upsert (never blocks ingestion; the
  Booking.com lesson of separating detection from delivery). The Sentinel
  loop drains the outbox, matches project rules (env/app filters), notifies.
- Optional per-rule `auto_investigate`: a matching signal starts the Phase-2
  Agno investigation automatically.

**2. Metric monitors** — scheduled, over `api_requests`:

- Fixed metric menu (Apitally's scale-appropriate choice, not arbitrary
  queries): `error_rate`, `server_error_rate`, `client_error_rate`,
  `request_count`, `p50_latency`, `p95_latency`.
- Scope: project + optional app slugs, environment, and a rich-filter string
  (reusing the existing DSL — endpoint/consumer/release scoping for free).
- `group_by`: `none` (one aggregate state) or `consumer` (Datadog Multi
  Alert: one state per consumer_id, capped to top 50 by volume, static
  thresholds only in v1 — per-consumer anomaly baselines are a later cost).
  This is the consumer-aware differentiator no generic tool ships.
- Threshold families (Sentry's two): `static` (comparison + value) and
  `anomaly` (see below).
- Window `window_minutes` (5/15/60), evaluated every `check_minutes`
  (default 5; Honeycomb-style bounds 1–60).

### State machine (the Grafana/Prometheus canon, flap-hardened)

Per (rule, target) state row: `ok → pending → firing → ok`.

- **pending → firing** after `for_windows` breaching evaluations out of the
  last `of_windows` (default 2 of 3, window-based **M-of-N instead of a
  strict consecutive duration** — directly addressing Google SRE's
  reset-on-dip caveat while keeping blip suppression).
- **firing → ok** only after `resolve_windows` (default 2) consecutive OK
  evaluations (Grafana `KeepFiringFor` / Apitally notify-after-resolved).
- Notifications only on `firing` and `resolved` transitions; while firing,
  re-notify at most every `renotify_minutes` (default **240** — the
  Alertmanager repeat_interval default). Resolved notifications on by
  default (Honeycomb's default), per-rule toggle.
- Muting: `is_active=False` (off) and `snooze_until` (silence); evaluation
  continues while snoozed, delivery is suppressed.
- One notification per rule per tick even when several targets transition
  (grouping-lite: consolidated body listing targets — Alertmanager group_by
  in spirit).

### Anomaly detection (robust stats, no ML — the practitioner consensus)

For a metric window ending now, build the baseline from up to 14 history
values of the same window length: the 6 immediately-trailing windows, the
same window 24h ago ±1, and the same window 7d ago ±1 (seasonal-naive,
Booking.com / Honeycomb dynamic-baseline offsets).

1. **Clean history** (Booking.com's incident-contamination fix): drop values
   with MAD-z > 3 from the history set before computing the baseline.
2. Baseline = median(history); spread = MAD(history).
3. Band = baseline ± `sensitivity` × max(MAD-σ, metric floor). Sensitivity
   default 3 (Datadog bounds guidance 2–3). Metric floors keep the band
   honest when history is flat: rates 2 percentage points, latency 15% of
   baseline, counts 30% of baseline.
4. **Guards** (the low-traffic/cold-start pitfalls):
   - `min_events` (default 10 requests in the window) or the evaluation is a
     no-op — Watchdog's minimum-traffic gate, Google's low-traffic warning.
   - <4 usable history values → no-op (Datadog's ≥3-cycles cold-start rule,
     scaled to our windows).
   - **Deploy grace**: skip anomaly evaluations for 15 minutes after a
     deploy in the same project/environment (deploy-time noise; we have
     first-class deploy events, most competitors don't).
5. Direction configurable: `above`, `below`, or `both` (traffic *drops* are
   the below case — consumer churn signal).

### Notifications

- **Channels**: Slack incoming webhook (Block Kit body + required `text`
  fallback), generic webhook (Alertmanager-inspired versioned JSON:
  `{version, status: firing|resolved, project, rule, targets[], value,
  threshold, links}`), email (existing Django/Resend plumbing).
- **Retry taxonomy** (per research): retry only 5xx/timeout/429 (honoring
  `Retry-After`), 3 attempts, exponential backoff with jitter; other 4xx
  fail fast and are recorded. Slack's non-retriable error codes
  (`invalid_payload`, `action_prohibited`, …) are 4xx → covered.
- **AI triage line** (differentiator): when AI is configured, firing
  notifications carry a one-sentence Agno-generated triage summary
  (impact-first); fails soft to a templated line.
- Every delivery attempt lands in `AlertEvent` (the in-app feed): rule,
  targets, transition, value/threshold, summary, per-channel outcome.

### Architecture

```
apps/ingest ──(same txn as issue upsert)──▶ alert_signals (outbox)
                                                   │
manage.py run_sentinel  ── every 60s ──┬─ drain signals → issue rules → notify
   (own container/process,            ├─ evaluate due metric monitors (CH windows)
    like the ingest split)            ├─ state machine per target → notify
                                      └─ write AlertEvent history
Django API ── channels/rules CRUD, events feed, test-channel
Settings UI ── Alerts tab: channels, rules, recent alerts
```

Rationale: no Celery/queue exists in this stack; a single-process evaluator
loop matches the competitor cadence norms (1–15 min) at our scale, and the
outbox keeps ingest latency untouched. State lives in Postgres
(`alert_states`) so the evaluator restarts cleanly (Grafana persists alert
state for exactly this reason).

## Out of scope for v1 (recorded, deliberate)

PagerDuty/Teams/Discord/Jira channels (webhook covers them via bridges);
per-consumer anomaly baselines; Datadog-style warn thresholds + recovery
thresholds; composite monitors; SLO burn-rate alerting (Google's multiwindow
multi-burn-rate is the roadmap north star for v2); notification routing
trees; inhibition rules; alert-storm LLM clustering (Phase 6).
