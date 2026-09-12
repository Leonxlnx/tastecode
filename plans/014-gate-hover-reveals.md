# 014 — Gate hover reveals

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: MEDIUM
- **Category**: input modality
- **Estimated scope**: 5 files, about 80 lines reorganized or tested

## Problem

Hover-only action reveals can stick after a tap on coarse pointers. Audit edits added fine-pointer
media blocks, but `app.css` currently duplicates the same hover selectors in the base rule and then
neutralizes them with a coarse-pointer override.

```css
/* apps/web/src/styles/app.css:549 — current */
.sessrow:hover .sess__actions,
.sessrow:focus-within .sess__actions,
.proj__head:hover .dots {
  opacity: 1;
  pointer-events: auto;
}
```

## Target

Keep `:focus-within` rules outside media queries for keyboard access. Put every reveal caused only by
`:hover` inside `@media (hover: hover) and (pointer: fine)`. Remove duplicate base hover selectors and
the now-unneeded coarse-pointer neutralization block. Apply the same structure to inbox quick actions,
Settings issue bubbles, and thread message actions.

## Repo conventions to follow

- `app.css` already gates Composer decorative hover at `@media (hover: hover) and (pointer: fine)`.
- Focus behavior remains unconditional and must not be coupled to pointer capability.

## Steps

1. In `app.css`, leave only session `:focus-within` reveal/hide selectors at base scope.
2. Keep session-row and project-header `:hover` selectors only in the fine-pointer media block.
3. Remove the coarse-pointer override made redundant by step 2.
4. Confirm inbox, Settings, and thread CSS use the same focus-outside/hover-inside structure.
5. Rewrite `hover-gating.test.ts` to reject base-scope hover reveal selectors, not only to assert that
   a fine-pointer block exists.

## Boundaries

- Do NOT remove keyboard focus reveals.
- Do NOT change durations, easing, or action geometry.
- Do NOT gate click or focus behavior.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/styles/hover-gating.test.ts apps/web/src/ui/InboxSidebar.test.tsx` passes.
- **Feel check**: mouse hover reveals actions; keyboard focus reveals the same actions; touch emulation
  does not leave hidden action controls visible after a tap.
- **Done when**: all four surfaces pass mouse, keyboard, and coarse-pointer checks with no sticky state.
