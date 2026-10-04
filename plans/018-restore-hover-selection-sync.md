# 018 — Restore hover selection sync

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: HIGH
- **Category**: pointer and keyboard interaction
- **Estimated scope**: 6 files, about 70 lines

## Problem

Audit edits removed pointer-enter state updates from three listboxes. CSS still paints the hovered row,
but Enter uses the stored keyboard selection, so a user can hover one row and activate another.

```tsx
/* apps/web/src/ui/CommandPalette.tsx:160 — current */
<button
  key={command.id}
  type="button"
  role="option"
  aria-selected={selected === index}
  onClick={() => run(command)}
>
```

```tsx
/* apps/web/src/ui/SessionSearch.tsx:368 — current */
<button
  key={result.key}
  role="option"
  aria-selected={selectedKey === result.key}
  onClick={() => props.onSelect(result.threadId, result.turnId)}
>
```

```tsx
/* apps/web/src/ui/ComposerResourcePicker.tsx:218 — current */
<button
  type="button"
  role="option"
  aria-selected={isActive}
  onClick={() => props.onSelect(item)}
>
```

## Target

Restore one state update on pointer entry for each row: `setSelected(index)` in CommandPalette,
`setSelectedKey(result.key)` in SessionSearch, and `setActiveIndex(index)` when available in
ComposerResourcePicker. Use `onPointerEnter` or the original `onMouseEnter`; do not use `onMouseMove`.
The row painted as selected must always be the row Enter activates.

## Repo conventions to follow

- All three controls use `role="option"` and `aria-selected` as their selection contract.
- Keyboard ArrowUp/ArrowDown remains the other owner of the same active state.

## Steps

1. Restore pointer-entry selection sync in all three components.
2. In each existing component test file, hover or pointer-enter a non-active row, press Enter on the
   owning input/listbox, and assert that exact row is activated.
3. If ComposerResourcePicker has no direct test, add `ComposerResourcePicker.test.tsx` with only the
   selection contract.
4. Ensure pointer entry does not cause repeated state updates while the pointer moves inside a row.

## Boundaries

- Do NOT add hover animation.
- Do NOT use `mousemove` or `pointermove`.
- Do NOT change result ordering, filtering, or click behavior.
- Do NOT replace keyboard focus with DOM focus on every hover.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/ui/CommandPalette.test.tsx apps/web/src/ui/SessionSearch.test.tsx apps/web/src/ui/ComposerResourcePicker.test.tsx` passes.
- **Feel check**: in each surface, move the pointer from the first row to a later row and press Enter.
  The highlighted row activates. Move back to keyboard arrows; selection remains continuous.
- **Done when**: visual highlight, `aria-selected`, `aria-activedescendant`, and Enter target agree.
