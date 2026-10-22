---
paths:
  - "src/components/ui/**"
---

# Editing primitives (src/components/ui)

- A primitive owns its color, typography, shape and motion. New looks are new `cva` variants, never call-site overrides.
- Every interactive primitive has: `focus-ring` (or border + ring for fields), hover, active, disabled, and `data-[state=open]` if it triggers an overlay.
- Sizes come from the control scale: 28 (`h-7`), 32 (`h-8`), 36 (`h-9`). Radius `rounded-md` for controls, `rounded-lg` for menus, `rounded-xl` for dialogs.
- Depth only from `shadow-panel | shadow-control | shadow-control-primary | shadow-control-destructive | shadow-overlay`.
- Icons from `./icon`. Re-export new ones there.
- After any change: update `src/app/design/page.tsx` so every variant and state is visible, then `pnpm check`, then look at `/design` in both themes.
