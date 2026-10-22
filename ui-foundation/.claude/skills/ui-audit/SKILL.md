---
name: ui-audit
description: Read-only audit of APILens UI against the Aperture design system. Combines scripted checks (ui-guard, contrast, ESLint design rules) with a visual review by the design-reviewer subagent, and returns ranked findings with file:line and fixes. Use when the user runs /ui-audit.
argument-hint: "[route like /projects/checkout-api, or a path under src/; default: changed files]"
disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pnpm ui:check *)
  - Bash(pnpm ui:check)
  - Bash(pnpm ui:contrast)
  - Bash(pnpm lint *)
  - Bash(pnpm lint)
  - Bash(pnpm exec eslint *)
  - Bash(git diff *)
  - Bash(git status *)
---

# /ui-audit

Target: **$ARGUMENTS** (if empty: files changed vs HEAD in `src/`, from `git diff --name-only HEAD -- src` plus untracked files, and the routes that render them).

**Do not edit files.** This produces findings; fixing is a separate step the user asks for.

## 1. Scripted pass

Run and collect:
- `pnpm ui:check <files>`: design-system and anti-slop rules
- `pnpm exec eslint <files>`: `@shadcn/lint` restyle, unknown-class and inline-style rules, plus React rules
- `pnpm ui:contrast`: only if `tokens.css` is in scope

## 2. Code pass

Read each file in scope against [checklist.md](checklist.md) sections A–D, the parts that need judgment and that scripts can't decide: hierarchy, one primary action, the four states present, copy quality, permission gating, URL scope, semantics.

## 3. Visual pass

Delegate to the **design-reviewer** subagent with the routes in scope. Tell it the dev server is on http://localhost:3100 (start `pnpm dev` first if it isn't running), and to cover 1440×900 and 390×844 in dark and light. It returns screenshot paths and findings.

## 4. Report

One table, most severe first, de-duplicated across passes:

| Severity | Where | Finding | Fix |
|---|---|---|---|
| blocker / major / minor / nit | `file:line` or route + viewport | one sentence | the concrete change |

- **blocker:** broken layout, unreadable contrast, inaccessible control, action in an unlabeled tenant or environment, data shown as empty when the fetch failed.
- **major:** a non-negotiable from AGENTS.md broken, a missing state, a primitive restyled at the call site, an AI tell.
- **minor:** inconsistency with `/design`, copy that misses the voice, spacing off rhythm.
- **nit:** polish.

End with: counts per severity, what was verified visually, and what wasn't checked.
