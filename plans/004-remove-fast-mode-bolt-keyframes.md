# 004 — Remove fast-mode bolt keyframes

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: MEDIUM
- **Category**: Interruptibility and cohesion
- **Estimated scope**: 2 files, about 45 lines

## Problem

Both `aria-pressed` values select a keyframe animation, so the bolt animates every time the control
mounts and every time it changes. The on animation lasts 320ms, scales from `0.7` to `1.25`, and
animates a brightness/drop-shadow filter. A quick second toggle restarts the keyframes from frame 0.

```css
/* apps/web/src/styles/app.css:8521 — current */
.model-selector__fast-icon {
  display: grid;
  place-items: center;
  transition: transform var(--dur-press) var(--ease-out);
}
.model-selector__fast[aria-pressed='true'] .model-selector__fast-icon {
  animation: fast-bolt-on 320ms cubic-bezier(0.2, 1.6, 0.4, 1);
}
.model-selector__fast[aria-pressed='false'] .model-selector__fast-icon {
  animation: fast-bolt-off 260ms var(--ease-out);
}

@keyframes fast-bolt-on {
  0% {
    transform: scale(0.7);
    filter: brightness(1);
  }
  48% {
    transform: scale(1.25);
    filter: brightness(1.8) drop-shadow(0 0 5px currentColor);
  }
  100% {
    transform: scale(1);
    filter: brightness(1);
  }
}

@keyframes fast-bolt-off {
  45% {
    transform: scale(0.78);
    opacity: 0.55;
  }
}
```

The control already has calm state and press feedback:

```css
/* apps/web/src/styles/app.css:8494 and 8565 — current */
.model-selector__fast {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  padding: 0;
  background: none;
  border: 0;
  border-radius: var(--r-md);
  color: var(--text-3);
  cursor: pointer;
  font: inherit;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}
.model-selector__fast-icon svg {
  fill: transparent;
  transition:
    fill var(--dur-fast) var(--ease-out),
    rotate var(--dur-fast) var(--ease-out);
}
```

## Target

Delete the bolt keyframes and the icon wrapper's unused transform transition. Keep the existing
180ms color/background/fill state transition and the existing 140ms `scale(0.97)` button press.
There must be no filter animation and no mount animation.

## Repo conventions to follow

- Use the existing `--dur-fast: 180ms`, `--dur-press: 140ms`, and
  `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` declarations from
  `apps/web/src/styles/tokens.css:204`.
- `apps/web/src/styles/app.css:9058` uses the same `scale(0.97)` press on `.btn`; keep the fast
  control's current matching press.
- Preserve independent `rotate`; it lets the global icon hover tilt coexist with other transforms.

## Steps

1. Remove `transition: transform var(--dur-press) var(--ease-out)` from
   `.model-selector__fast-icon`.
2. Delete both `aria-pressed` animation rules and both `fast-bolt-*` keyframe blocks.
3. Remove `.model-selector__fast .model-selector__fast-icon` from the nearby reduced-motion rule,
   because it will no longer animate. Keep the two `.composer__design` selectors in that rule.
4. Do not change the parent control transition, SVG fill/rotate transition, `.is-on` state, or
   `:active` press.
5. Add `apps/web/src/styles/fast-mode-motion.test.ts`. Assert that `fast-bolt-on`,
   `fast-bolt-off`, `filter: brightness`, and an icon-wrapper transform transition are absent. Assert
   that the parent uses `var(--dur-fast)` for state and `var(--dur-press)` for transform, and that
   `:active` remains `scale(0.97)`.

## Boundaries

- Do NOT change service-tier values, callbacks, labels, markup, haptics, or model capability logic.
- Do NOT remove the SVG fill transition or global icon hover tilt.
- Do NOT add a new bounce, spring, animation library, or dependency.
- If the keyframe selectors differ after commit `bfc88477`, STOP and report the drift.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/fast-mode-motion.test.ts src/ui/ModelSelector.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Open the picker with fast mode both on and off. The bolt must not pulse on mount.
  Toggle it quickly five times. Color, background, and fill must retarget smoothly with no restart,
  overshoot, glow, or lag. The button must still press to `0.97` in 140ms.
- **Done when**: All bolt keyframes and filter work are gone, and fast state remains clear through
  the existing restrained transitions.
