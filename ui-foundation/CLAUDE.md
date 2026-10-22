@AGENTS.md

# Claude Code in this folder

Launch Claude Code from this directory (`cd ui-foundation && claude`). Hooks,
MCP servers and the reviewer agent only load from the launch directory.

## What's wired up

- **Skill `aperture-ui`** loads automatically for any UI work: the full rules, decision tables and references. Read its references when a task touches that area, not all at once.
- **`/new-screen <what it's for>`** runs the screen workflow end to end: spec, compose, states, checks, visual verification.
- **`/ui-audit [route or path]`** runs a read-only audit: scripted checks plus the `design-reviewer` subagent's visual pass, findings ranked by severity.
- **Hook:** `scripts/ui-guard.mjs --hook` runs after every Edit/Write in `src/`. Errors come back to you as a blocking message: fix them in the same turn. Suppress only with `ui-guard-ignore <rule>: <reason>` when the reason is real (e.g. SVG geometry).
- **MCP:** `playwright` (look at what you built) and `shadcn` (browse registry components before writing one).

## Working rules for Claude

- Before building, open `src/app/design/page.tsx` and the closest existing page. Reuse their structure.
- Adding a shadcn/ReUI registry component: add it, then bring it onto Aperture. Swap icon imports to `@/components/ui/icon`, remove stock palette/shadow/radius classes, map colors to our tokens, add it to `/design`, and run `pnpm check`.
- Never edit `src/styles/tokens.css` casually. A token change is a design decision: run `pnpm ui:contrast` and `pnpm design:sync`, then look at `/design` in both themes.
- Visual check before reporting done: `pnpm dev` (port 3100), then screenshot with Playwright at 1440×900 and 390×844, dark and light (`localStorage.theme`). Read the screenshots. Fix overlap, misalignment, truncation and contrast you can see.
- Report honestly: say what you verified visually, what passed `pnpm check`, and what you didn't check.
