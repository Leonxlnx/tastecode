# 003 — Remove the model check bounce

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: HIGH
- **Category**: Physicality and origin
- **Estimated scope**: 2 files, about 35 lines

## Problem

The selected-model check is conditionally mounted. Its CSS starts at `scale(0)`, rotates, overshoots
to `1.2`, and runs for 360ms. It therefore replays when the model picker opens even if the user did
not change the model. `scale(0)` also makes the mark appear from nothing.

```tsx
// apps/web/src/ui/ModelSelector.tsx:264 — current
{
  filteredEntries.length > 0 ? (
    filteredEntries.map((entry) => {
      const selected = entry.key === props.selectedChoice?.key
      return (
        <button
          key={entry.key}
          type="button"
          className={`model-selector__model${selected ? ' is-selected' : ''}`}
          aria-pressed={selected}
          aria-label={`Use ${entry.model.displayName} through ${entry.sourceName}`}
          onClick={() => props.onModelSelect(entry)}
        >
          <span className="model-selector__model-name">{entry.model.displayName}</span>
          {selected ? <Check size={14} aria-hidden /> : null}
        </button>
      )
    })
  ) : (
    <p className="model-selector__empty" role="status">
      No matching models.
    </p>
  )
}
```

```css
/* apps/web/src/styles/app.css:8915 — current */
.model-selector__model.is-selected > svg {
  animation: model-check-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes model-check-pop {
  0% {
    opacity: 0;
    transform: scale(0) rotate(-15deg);
  }
  60% {
    opacity: 1;
    transform: scale(1.2) rotate(3deg);
  }
  100% {
    opacity: 1;
    transform: scale(1) rotate(0deg);
  }
}
```

## Target

Render the check at its final size with no animation. The row color, focus outline, and check itself
already explain selection. Opening the picker and selecting a model must not bounce or rotate.

```css
/* target */
.model-selector__model > svg {
  flex: none;
  color: var(--text-2);
}
/* no selected-check animation and no model-check-pop keyframes */
```

## Repo conventions to follow

- `apps/web/src/ui/AppSelect.tsx:273` renders its selected `<Check>` with no check animation.
- `apps/web/src/styles/app.css:8400` gives that check only static layout and color. Match this calm,
  flat selector behavior.
- Do not change the shared motion tokens; deletion is the correct high-frequency fix.

## Steps

1. Delete `.model-selector__model.is-selected > svg` from `apps/web/src/styles/app.css`.
2. Delete the full `@keyframes model-check-pop` block.
3. Keep `.model-selector__model > svg`, `.model-selector__model.is-selected`, hover, and focus rules
   unchanged.
4. Add `apps/web/src/styles/model-check-motion.test.ts`. Assert that `app.css` contains neither
   `model-check-pop` nor a `transform: scale(0)` declaration, and that
   `.model-selector__model > svg` still contains `flex: none` and `color: var(--text-2)`.

## Boundaries

- Do NOT change `ModelSelector.tsx` markup, selection state, keyboard behavior, or check icon.
- Do NOT replace the bounce with another animation.
- Do NOT change AppSelect or the global 3-degree icon hover rule.
- Do NOT add a dependency.
- If the selected check is no longer conditionally rendered after commit `bfc88477`, STOP and report
  the drift.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/model-check-motion.test.ts src/ui/ModelSelector.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Open and close the model picker five times, then choose several models with mouse
  and keyboard. At normal speed and 10% playback, the check must appear as a stable state marker with
  no scale, spin, or overshoot. Focus and selected state must remain clear.
- **Done when**: The model check has no `model-check-pop` or `transform: scale(0)` declaration, and
  model selection remains fully visible and usable.
