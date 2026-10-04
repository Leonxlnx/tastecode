# 005 — Stop animating effort-slider width

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 2 files, about 30 lines

## Problem

Pointer movement updates a CSS width variable at each discrete effort stop. The fill then animates
the layout `width` for 170ms. Because the dither canvas observes that fill's geometry, the transition
also schedules repeated canvas work while the pointer is already moving.

```tsx
// apps/web/src/ui/ModelSelector.tsx:418 — current
const displayIndex = pointerIndex ?? props.selectedIndex
const displayedLabel =
  props.optionLabels[displayIndex] ?? props.optionLabels[props.selectedIndex] ?? 'Default'
const selectedProgress =
  displayIndex < 0 || props.optionLabels.length < 2
    ? 0.5
    : displayIndex / (props.optionLabels.length - 1)
const ditherWidthOffset =
  (1 - selectedProgress) * SLIDER_DITHER_MIN_WIDTH - selectedProgress * SLIDER_DITHER_INSET * 2
const ditherWidth = `calc(${selectedProgress * 100}% + ${ditherWidthOffset}px)`
const sliderVars: SliderStyle = {
  '--model-selector-slider-width': ditherWidth,
  '--model-selector-slider-inset': `${SLIDER_DITHER_INSET}px`,
}
```

```css
/* apps/web/src/styles/app.css:8657 — current */
.model-selector__slider-fill {
  position: absolute;
  inset-block: var(--model-selector-slider-inset);
  left: var(--model-selector-slider-inset);
  width: var(--model-selector-slider-width);
  overflow: hidden;
  background: var(--effort-fill);
  border-radius: var(--r-pill);
  box-shadow: var(--effort-fill-shadow);
  transition: width 170ms var(--ease-out);
}
```

```tsx
// apps/web/src/ui/dither-kit/DitherSlider.tsx:264 — current
const handleGeometryChange = () => {
  updateStrengthTarget()
  scheduleFrame()
}
const observer = globalThis.ResizeObserver
  ? new globalThis.ResizeObserver(handleGeometryChange)
  : null
```

## Target

Keep the discrete width calculation and ResizeObserver. Remove the width transition so each pointer
or keyboard change reaches its final stop in the same frame. One geometry update per changed stop is
acceptable; a 170ms series of resize callbacks is not.

```css
/* target */
.model-selector__slider-fill {
  width: var(--model-selector-slider-width);
  /* no transition on width */
}
```

## Repo conventions to follow

- The project performance rule is transform/opacity for animated properties. This plan chooses no
  animation because scaling the fill would also scale its dither canvas.
- Keep the pointer-capture and haptic detent behavior in `ModelSelector.tsx:433-533` unchanged.
- Keep `DitherSlider` geometry handling unchanged; it is required when the fill reaches a new size.

## Steps

1. Delete `transition: width 170ms var(--ease-out);` from
   `.model-selector__slider-fill` in `apps/web/src/styles/app.css`.
2. Do not add a transform replacement.
3. Add `apps/web/src/styles/effort-slider-motion.test.ts`. Assert that the fill still uses
   `width: var(--model-selector-slider-width)` and contains no transition or animation. Also assert
   that `app.css` has no transition whose property is `width`.

## Boundaries

- Do NOT change effort values, stop mapping, pointer capture, keyboard control, haptics, canvas
  drawing, or ResizeObserver code.
- Do NOT animate `scaleX`; it would distort the dither cells.
- Do NOT change slider geometry or visual sizes.
- Do NOT add a dependency.
- If the width transition is already absent after commit `bfc88477`, STOP and report the drift.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/effort-slider-motion.test.ts src/ui/ModelSelector.test.tsx src/ui/dither-kit/DitherSlider.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Drag across every effort stop slowly, then scrub back and forth quickly. The fill,
  label, active dot, and haptic detent must agree immediately. In DevTools Performance, each changed
  stop may resize once; there must be no resize/canvas tail after the pointer stops.
- **Done when**: Effort selection behavior is unchanged and no CSS width transition remains.
