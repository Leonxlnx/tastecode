# 011 — Own model-search styles

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: HIGH
- **Category**: visual correctness
- **Estimated scope**: 4 files, about 100 lines moved or tested

## Problem

`ModelSearchField` is shared by the model picker and Composer resource menus, but its CSS is owned by
the lazy Settings chunk. Opening either control before Settings loads leaves a raw browser search input.
Live Electron inspection showed `appearance: auto`, a native inset border, and the browser focus outline.

```tsx
/* apps/web/src/ui/ModelSearchField.tsx:1 — current */
import { useRef } from 'react'
import { IconSearch, IconX } from '@tabler/icons-react'
```

```css
/* apps/web/src/styles/settings.css:1148 — current */
.model-search {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
  border: 1px solid var(--chrome-border);
  border-radius: var(--r-lg);
}
```

## Target

Create `apps/web/src/styles/model-search.css` containing the full `.model-search` rule set now in
`settings.css`. Import it from `ModelSearchField.tsx`. Remove only that rule set from `settings.css`.
The control must have the same 34px height, border, radius, colors, focus ring, clear button, and
transitions regardless of which surface opens first.

## Repo conventions to follow

- Shared component styles are imported by their owning component, as in
  `apps/web/src/ui/ModelSelector.tsx` importing `../styles/model-selector.css`.
- Keep values on the existing tokens: `--dur-fast`, `--ease-out`, `--surface-2`, and
  `--chrome-border`.

## Steps

1. Move every `.model-search` selector from `apps/web/src/styles/settings.css` to the new
   `apps/web/src/styles/model-search.css` without changing values.
2. Import `../styles/model-search.css` from `apps/web/src/ui/ModelSearchField.tsx`.
3. Add a static ownership test in `apps/web/src/styles/model-search-ownership.test.ts` that asserts
   the owner import exists, `settings.css` no longer owns the selector, and the new file includes
   the reset and focus-within rules.

## Boundaries

- Do NOT change ModelSearchField markup or keyboard behavior.
- Do NOT import all of `settings.css` into a shared component.
- Do NOT add dependencies.
- Preserve unrelated dirty work.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/styles/model-search-ownership.test.ts apps/web/src/styles/startup-css-budget.test.ts apps/web/src/ui/ModelSelector.test.tsx` passes.
- **Feel check**: from a fresh Electron reload, open the model picker and Composer branch picker
  before opening Settings. Both search fields have the custom border, radius, background, and focus ring.
- **Done when**: computed input `appearance` is `none`, its own border and outline are absent, and
  the wrapper owns the visible border on first open.
