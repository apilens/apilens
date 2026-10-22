---
paths:
  - "src/app/**"
---

# Editing routes (src/app)

- Pages are Server Components. `params` and `searchParams` are Promises in this Next.js version: `const { slug } = await params`.
- Tenant pages live under `src/app/projects/[slug]/`, inside the layout that provides `AppShell` and `CapabilitiesProvider`. Don't re-wrap them.
- Page anatomy: `PageHeader` (noun title; actions: filters → time range → primary) → optional `StatRow` → `Panel`s. Max content width comes from AppShell.
- Scope (env, range, tz, tab, sort) belongs in `searchParams`, so views are shareable.
- Data that can fail renders its own `ErrorState` inside its panel; never let one panel's failure blank the page.
- Read `node_modules/next/dist/docs/` before using an App Router API you haven't used in this version.
