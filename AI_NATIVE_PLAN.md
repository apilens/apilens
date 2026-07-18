# APILens — AI-Native Launch Plan

*Research + planning document. Branch: `launch`. Date: 2026-07-15.*
*Status: DRAFT for phase-by-phase refinement — no development yet.*

This plan is grounded in two research passes done today:

1. **A full inventory of the APILens codebase** — every datastore column, SDK capture capability, analytics endpoint, and dashboard surface we have, plus what we do *not* collect.
2. **A verified market landscape** of AI-automated SDLC / "AI SRE" tooling as of mid-2026 (Sentry Seer/Autofix, GitHub Copilot coding agent, HolmesGPT, Keep, OpenHands, MCP ecosystem), with claims adversarially fact-checked against primary sources.

---

## 1. Where we stand today

### What we already collect (our AI raw material)

| Signal | Where | Why it matters for AI |
|---|---|---|
| Every HTTP request: method, templated `path` + exact `raw_path`, status, latency, req/resp sizes, IP, UA, env | `api_requests` (ClickHouse, 90d) | Baselines, anomaly detection, impact measurement |
| **Full request/response payloads + headers** (64KB, PII-redacted) | `api_requests` | Reproduction context no generic APM has |
| **Consumer identity** (id/name/group) on every request AND every error | `api_requests`, `api_logs` | Our unique differentiator: "who is affected" |
| **Real Python stack traces** for every unhandled exception / 5xx | `api_logs.payload` (30d) | The core input for root-cause analysis and auto-fix |
| **Distributed spans** incl. auto-instrumented outbound HTTP with `traceparent` propagation | `api_spans` (30d) | Cross-service root-cause ("the 502 came from Stripe") |
| `trace_id` joining requests ↔ spans ↔ error logs | all three tables | Multi-signal grounding, the Seer pattern |
| Rich filter DSL (12 fields, typed operators, compiles to parameterized SQL) | `filters.py` / `schema.ts` | Ready-made target language for NL → query translation |
| Auto-discovered endpoint registry with `last_seen_at` | Postgres `endpoints` | API-surface change detection |

### Latent assets (schema exists, nothing populates it)

- `api_logs` already has typed columns for **`attr_release`, `attr_commit`, `attr_version`, `attr_host`, `attr_region`, `attr_runtime`** — migration 004 pre-provisioned deploy/release correlation and the SDK never writes them. This is the cheapest possible on-ramp to "did this deploy break it?"
- `api_spans.kind` supports `db` / `internal` but only HTTP client spans are ever emitted.
- `api_logs` supports all log levels but only ERROR is ever written.

### What we do NOT have (all greenfield — verified zero hits)

- No AI/LLM/embedding/anomaly-detection code anywhere.
- No alerting, thresholds, notifications, webhooks, Slack/PagerDuty integration.
- No deploy/release/commit tracking populated; no git/SCM integration.
- No consumer dimension table (consumers are denormalized strings).
- No DB/cache/dependency spans; no infra metrics; no general app logs; no 4xx exception detail.
- No incidents, saved views, SLOs, rollup tables.
- Error "issues" grouping is a naive exact GROUP BY on `(method, path, status, message)` — dynamic values fragment issues.

**Read:** we are sitting on unusually rich per-request data (payloads + consumer + traces + stack traces joined by `trace_id`) with zero intelligence built on top. That's the best possible starting position for an AI-native pivot: no legacy AI features to unwind.

---

## 2. Market landscape (verified, mid-2026)

Key verified findings (all claims 3-0 or 2-1 in adversarial verification; sources are primary docs fetched 2026-07-15):

1. **The error→fix loop is shipped product, not demo-ware.** Sentry Seer/Autofix runs a three-stage pipeline — *root cause → solution plan → PR draft* — with per-stage stopping points ("Stop after Root Cause / Plan / PR Drafted"), grounded in errors + stack traces + distributed traces + logs + profiles + linked repo code. ([docs.sentry.io/product/ai-in-sentry/seer/autofix](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/))
2. **Coding-agent handoff is the dominant pattern — nobody sane builds codegen in-house.** Seer can delegate its final fix step to **Claude Code, Cursor, or GitHub Copilot**; GitHub's official roadmap (#1205, Preview) adds launching the Copilot coding agent directly from Sentry RCA. The value is eliminating the glue work: copying stack traces, finding files, re-explaining the problem.
3. **The telemetry→code plumbing is explicit and boring:** a GitHub App (read/write on contents, issues, PRs), **code mappings** (stack-trace path root → repo/directory), **suspect commits** (match stack-trace files against recent commit authorship), and stack-trace linking to exact source lines. This plumbing is the *prerequisite* for every AI fix feature.
4. **Vendor-hosted MCP servers are the emerging standard interface** between telemetry and coding agents. Sentry hosts one at `mcp.sentry.dev` (OAuth, 16+ tools over issues/traces/releases), including NL→query translation via an embedded LLM agent. An MCP server makes every coding agent a client of your product for free.
5. **Open source splits into three reusable layers:** **HolmesGPT** (CNCF Sandbox, LLM-agnostic agentic investigator over 60+ live data sources, bidirectional alert integrations, 24/7 operator mode — and it *does* cross into remediation via GitHub MCP); **Keep** (12k★ alert-management/AIOps hub, "GitHub Actions for monitoring tools", deliberately stops before code fixes); **OpenHands SDK** (event-sourced, replayable agent runtime — the template for a remediation worker).
6. **Exploitable gaps:** Sentry's SCM support is **cloud-only** (no self-hosted GitHub/GitLab, no Bitbucket/Azure DevOps — documented, requested, unshipped). And no incumbent has **API-consumer-aware context**: which consumers an error hits, what traffic/revenue is affected, per-consumer regression detection. That is our data model's home turf.

**Common architecture across the landscape (the "four-layer stack"):**

```
Layer 1  SCM plumbing        GitHub App · code mappings · releases · suspect commits
Layer 2  Multi-signal RCA    errors + traces + logs + payloads + code, staged pipeline
Layer 3  MCP interface       hosted MCP server, NL→query, telemetry tools for agents
Layer 4  Agent handoff       Claude Code / Cursor / Copilot do the fix; we do context
```

**Research caveats (honest):** coverage skewed to Sentry/GitHub/MCP (claims about Datadog Bits AI, New Relic AI, Resolve.ai, Cleric, Traversal, PagerDuty AI did not survive verification — treat the competitive picture beyond Sentry as unverified); no independent efficacy data exists anywhere (fix-acceptance rates etc.); the space moves monthly, re-check before each phase commits.

---

## 3. Strategy

**Positioning sentence:** *APILens watches your API in production and fixes it — every error arrives with the root cause, the suspect commit, the consumers it hurt, and a PR-ready handoff to your coding agent.*

Three strategic bets, straight from the verified landscape:

1. **Context over codegen.** We never build our own code-fixing model. We become the best *context assembler* (stack trace + trace waterfall + real request payload + consumer impact + suspect commit) and hand off to Claude Code / Copilot / Cursor. Cheap for us, on-trend, and exactly the Seer pattern.
2. **Consumer-aware everything.** Every AI output leads with impact: "*breaks checkout for 3 enterprise consumers, 4.2% of traffic*". Generic tools can't say this; our schema already can.
3. **The loop, not features.** The seven features below form one connected loop — detect → group → investigate → fix → verify → report — each stage feeding the next. That's what makes "AI-native" credible instead of a chatbot bolted on a dashboard.

```
        F5 Sentinel          F2 Fingerprint         F3 Investigator
   anomaly detected ──▶ grouped into an issue ──▶ RCA + suspect commit
                                                        │
        F7 Narrator          (verify via F5)       F4 Fix handoff
   postmortem + impact ◀── deploy watched ◀── PR opened by coding agent
                                                        
        F1 Code Link = plumbing under F3/F4        F6 MCP = agents query everything
```

---

## 4. The top seven connected features

### F1 · Code Link — GitHub integration, releases, suspect commits *(the prerequisite layer)*

The plumbing every AI feature stands on. Without it, RCA is guesswork and auto-fix is impossible.

- GitHub App: repo connect per project, contents/PR/issue permissions, webhooks.
- **SDK release/commit tagging**: `release=`, `commit=` config (+ auto-detect from env vars / git); populate the already-existing `attr_release`/`attr_commit` columns and add the same columns to `api_requests` + `api_spans`.
- Deploy events API (`POST /v1/deploys`) + deploy markers on every chart.
- **Code mappings** (stack-trace path root → repo path) with auto-derivation from the first stack traces seen.
- **Suspect commits**: match stack-trace frames against recent commit history; show author + diff on every error issue.
- Stack-trace frames become links to source lines on GitHub.
- *Differentiator (Sentry's documented gap): support self-hosted GitHub/GitLab from day one.*

### F2 · Smart issue fingerprinting *(fix grouping before AI reads it)*

Naive `(method, path, status, message)` grouping fragments issues (any dynamic value in a message = new "issue") and poisons everything downstream — you can't do RCA, alerting, or regression detection on fragmented issues.

- Normalize messages (strip ids/UUIDs/numbers/emails) + fingerprint on exception type + top stack frames (in-app frames preferred).
- Embedding-based merge suggestion for near-duplicate issues ("these 3 issues look like one bug — merge?").
- Issue lifecycle: new / regressed / resolved / ignored — **"regressed in release X"** becomes computable once F1 lands.
- New-issue detection = the trigger wire for F5 alerts and F3 auto-investigations.

### F3 · The Investigator — AI root-cause analysis *(the heart)*

Per error issue, a staged agentic investigation (Seer's three-stage pattern, HolmesGPT's toolset pattern), with user-configurable stopping points (*stop after root cause / after plan / after PR*):

Grounding context we can assemble **that nobody else has in one place**:
- full stack trace + exception chain (`api_logs.payload`)
- the trace waterfall incl. downstream HTTP calls that failed (`api_spans`)
- the **actual request payload/headers** that triggered it (redacted)
- what changed: suspect commit + deploy timeline (F1)
- blast radius: affected consumers, endpoints, % of traffic, first/last seen
- history: did this endpoint error before, at what baseline

Output on every issue page: root-cause hypothesis with confidence, evidence trail (which spans/payloads/commits it looked at), impact statement, proposed fix plan. LLM-agnostic backend (Anthropic default, BYO key — the HolmesGPT/Keep pattern).

### F4 · Fix handoff — from issue to PR *(close the loop)*

- **"Fix with your agent" button**: assemble a complete fix brief (RCA + stack trace + suspect commit + repro payload + failing-request cURL) and hand off to **Claude Code** (Agent SDK), **GitHub Copilot coding agent**, or **Cursor** — one click, no copy-pasting.
- MCP-first: the agent can call back into our MCP server (F6) mid-fix to pull more telemetry.
- Optional later stage: our own hosted fix worker (OpenHands-style event-sourced runtime) that drafts the PR itself for simple cases; PR links back to the issue; issue auto-resolves when the fix deploys (verified via F1 release tracking + F5 monitoring).
- **Post-fix verification is ours to own**: after the fix PR's release deploys, the Sentinel watches the issue's fingerprint and confirms "error rate back to baseline — fix verified in production." No coding-agent vendor can do this; it closes the loop only an observability product can close.

### F5 · The Sentinel — anomaly detection + smart alerting *(detect without dashboards)*

Currently a user must *look* at the dashboard to know something's wrong. AI-native means the product notices first.

- Alerting infrastructure (net-new): alert rules, channels (Slack, email, generic webhook, PagerDuty), delivery + dedup. Adopt Keep's lesson: provider-based integrations, don't hand-build fifty.
- Baseline/seasonality per endpoint × environment (error rate, p95 latency, traffic volume) over ClickHouse rollups — statistical first (MAD/seasonal z-score), no LLM needed for detection.
- **Consumer-level anomalies** (unique to us): "consumer X's 4xx rate tripled — their integration broke", "consumer Y's traffic dropped 90% — churn signal".
- New-issue + regression alerts wired from F2; every alert carries an LLM-written one-paragraph triage summary and links straight into an F3 investigation.

### F6 · APILens MCP server + natural-language telemetry *(the open interface)*

The Sentry-validated pattern: a hosted MCP server makes every coding agent and every Claude/ChatGPT user a client of our product.

- `mcp.apilens.ai` — OAuth-scoped to project, tools over our existing analytics API: `search_requests`, `get_trace`, `list_error_issues`, `get_issue` (with stack trace), `consumer_impact`, `endpoint_stats`, `list_releases`, `diff_releases`.
- **NL → filter DSL translation**: our filter grammar (`field:op:value`) is small and typed — a perfect compile target. Same translator powers an "Ask APILens" search box in the dashboard (type "slow checkout requests from acme yesterday" → filled FilterBar).
- This is also *how F4 agents pull context mid-fix* — the MCP server is the API of the whole AI loop.

### F7 · The Narrator — incident narratives, postmortems, digests *(AI-native reporting)*

- Auto-drafted **incident timeline/postmortem** per resolved issue: when it started, suspect deploy, blast radius by consumer, the fix PR, verification. (Feeds from F1–F5; mostly retrieval + one LLM synthesis pass.)
- **Weekly API health digest** to Slack/email: new issues, regressions, slowest endpoints, consumer anomalies, API-surface changes (new/removed endpoints from the `endpoints` registry).
- **Consumer impact reports**: per-consumer "what broke for you and when" — support teams can send these; nobody else has the data shape for it.

### Why these seven

Each one feeds the next (detect→group→investigate→fix→verify→narrate), F1 is the plumbing under F3/F4/F7, and F6 exposes all of it to the agent ecosystem. Shipping any five of the seven still forms a coherent story; shipping all seven is a defensible "AI-native API observability" claim no small competitor currently makes.

---

## 5. Smaller AI-native touches (cheap, additive)

Roughly ordered by effort-to-wow ratio:

1. **"Explain this request"** in the request modal — one LLM call over data already on screen (status, payload, trace, headers).
2. **cURL → failing test**: we already generate repro cURL; also generate a pytest/httpx test case for the bug report / fix brief.
3. **AI endpoint descriptions**: auto-describe discovered endpoints from method/path/sample payloads; editable.
4. **API-surface changelog**: alert when endpoints appear/disappear or response shapes drift (we have `endpoints.last_seen_at` + payloads).
5. **Alert-noise control**: LLM dedup/clustering of alert storms into one incident (Keep's core trick).
6. **SDK setup copilot**: paste your framework/stack in the app-setup page, get exact middleware config incl. redaction suggestions ("I see `card_number` in your payloads — add this redact rule").
7. **PII leak detector**: periodic scan of stored payloads for unredacted PII patterns → suggested `redact_*` config PR to the user's repo (via F1).
8. **Latency attribution notes**: on slow traces, auto-annotate the dominant span ("87% of this request is the Stripe call").
9. **Issue titles that read like humans wrote them**: "Checkout 500s when coupon code is empty" instead of `ValueError: ...`.
10. **Docs/answer bot** on the docs site + in-app, grounded in `apps/docs`.

---

## 6. Data prerequisites (collection roadmap)

Gaps we must close, mapped to the features they unblock:

| Prerequisite | Unblocks | Notes |
|---|---|---|
| SDK `release`/`commit`/`version` tagging → populate `attr_*` cols; add to `api_requests`/`api_spans` | F1, F2 regressions, F3, F7 | Columns already exist in `api_logs`; SDK change + ingest passthrough |
| Deploy events endpoint + storage | F1, F5, F7 | Small: one table + one ingest route |
| Consumer dimension table (Postgres) — metadata, tier/plan, first/last seen | F5, F7, consumer reports | Backfill from ClickHouse distincts |
| Issue/fingerprint storage (Postgres) — issues become entities with lifecycle | F2, F3, F4, F5 | Today "issues" are just GROUP BY rows |
| Alert rules/channels/deliveries tables + worker | F5, F7 | Net-new subsystem |
| ClickHouse rollup/materialized views (per endpoint×env×hour) | F5 baselines, cheap digests | Also speeds existing dashboard |
| Optional 4xx error capture (opt-in log rows for 4xx with context) | richer F3/F5 | SDK flag |
| DB-query spans (SQLAlchemy/psycopg/redis instrumentation) | deeper F3 RCA | `kind=db` already in schema; bigger SDK lift — later phase |
| LLM provider config per project (BYO key option) + prompt/cost telemetry | F3, F6, F7, all touches | Decide default provider + unit economics early |

---

## 7. Phase plan (draft — to refine together)

Sized for a small team; each phase ships user-visible value and feeds the next. Rough effort in engineer-weeks (ew).

**Phase 0 — Foundations & data (3–4 ew)** — ✅ **SHIPPED 2026-07-15 (launch branch)**
Release/commit/deploy tagging end-to-end (SDK → ingest → ClickHouse → deploy markers on charts); issue fingerprinting v1 (normalization + stack-frame hash, issues as Postgres entities); consumer dimension table; rollup views. *Exit: "this issue regressed in v1.4.2" is computable.*
*Shipped: SDK 0.5.0 release/commit tagging + `release` filter field; `POST /v1/deploys` + Traffic chart markers; fingerprint column + ErrorIssue lifecycle entities (open/regressed/resolved/ignored) + fingerprint-grouped error-issues API; Consumer dimension table + `backfill_consumers`. Deferred to Phase 5: ClickHouse rollup views (needed for baselines, not for the RCA spine). New Django migrations 0018–0020 are gitignored — apply per environment.*

**Phase 1 — Code Link (3–4 ew)** — ✅ **SHIPPED 2026-07-15 (launch branch)**
GitHub App (cloud + self-hosted), repo connect UI, code mappings w/ auto-derivation, suspect commits on issue pages, stack-frame → source links. *Exit: every error issue shows the suspect commit + author.*
*Shipped: apps/integrations (installation/repository/app-level code mappings — monorepo & polyrepo), hardened install flow (signed state + server-side verification of the untrusted installation_id), lifecycle webhooks (uninstall/suspend/repo-removal + lazy revocation), deploy-aware suspect commits (scoped to the Phase 0 stamped running commit), Settings → Integrations UI, /github/setup callback, suspect commits + source links in the Errors inspector. See PHASE1_CODE_LINK_DESIGN.md for the edge-case matrix. Deferred: automatic code-mapping derivation from observed traces; GHES UI (model-ready via base_url); user-token installation verification (residual risk documented).*

**Phase 2 — The Investigator (4–6 ew)** — ✅ **SHIPPED 2026-07-18 (launch branch, Agno framework)**
LLM plumbing (provider config, BYO key, cost metering); staged RCA pipeline over stack trace + trace + payload + suspect commit + impact; evidence-trail UI on the Errors page; "Explain this request" + humanized issue titles ride along. *Exit: one-click RCA with confidence + impact statement.*
*Shipped: apps/ai on Agno 2.7 (Anthropic provider, APILENS_AI_MODEL default claude-sonnet-5) — deterministic evidence assembly (issue + events + trace waterfall + captured request + suspect commits + deploys), two-stage structured pipeline (RootCauseAnalysis with read-source-at-running-commit tool → FixPlan), Investigation entity with token metering, background-thread runner, poll-based API with in-flight dedupe, and the Investigate panel (confidence chip, evidence trail, fix plan, patch sketch) in the Errors inspector. Deferred: per-project BYO keys, "Explain this request", humanized titles, auto-trigger on new issues (Phase 5 wiring). Needs APILENS_AI_API_KEY per environment; live LLM run pending a key.*

**Phase 3 — MCP server + NL query (3–4 ew)**
Hosted MCP (`mcp.apilens.ai`, OAuth, project-scoped) exposing the analytics API; NL→filter-DSL translator; "Ask APILens" box in the dashboard. *Exit: Claude Code can investigate your API from the terminal; marketing can say "MCP-native".*

**Phase 4 — Fix handoff (3–5 ew)**
Fix-brief assembly; Claude Code / Copilot / Cursor handoff buttons; repro cURL→test generation; fix-PR ↔ issue linking; **fix verification** (post-deploy fingerprint watch, "verified in production" state). *Exit: error → PR → verified, demoable end-to-end.*

**Phase 5 — Sentinel: alerting + anomalies (5–7 ew)**
Alert infra (rules/channels/dedup: Slack, email, webhook, PagerDuty); statistical baselines per endpoint & per consumer; new-issue/regression alerts with LLM triage summaries; auto-trigger Investigator on alert. *Exit: APILens notices before the customer does.*

**Phase 6 — Narrator + polish (3–4 ew)**
Auto postmortems, weekly digests, consumer impact reports; API-surface changelog; alert-storm clustering; SDK setup copilot + PII leak detector. *Exit: the full loop narrates itself.*

Sequencing rationale: 0→1→2 build the RCA spine (most demo value per week); MCP (3) before handoff (4) because agents use it during fixes; alerting (5) is the biggest net-new subsystem so it comes after the loop exists to alert *into*; 6 harvests everything.

**Re-verify before Phase 2 commits:** Datadog/New Relic/AI-SRE-startup capabilities (unverified in this research), MCP auth/multi-tenancy best practice, and LLM pricing — the landscape moves monthly.

---

## 8. Open questions for refinement

1. **Build order vs. GTM**: ship Phases 0–2 quietly and launch "AI-native" at Phase 4 (full loop demo), or market each phase as it lands?
2. **LLM economics**: bundled (we pay, priced into plans) vs BYO-key vs both? Seer is a paid add-on; sentry-mcp supports BYO provider — both patterns are validated.
3. **Language expansion**: everything above works with the Python SDK today. Does Node/Go SDK work slot in before or after Phase 5? (Suspect commits + RCA are language-agnostic once stack traces flow.)
4. **Hosted fix worker (own OpenHands-style runtime)**: worth it after handoff proves demand, or never (stay handoff-only)?
5. **Self-hosted SCM as a wedge**: how loudly do we market the Sentry gap (self-hosted GitLab/GitHub support)?
