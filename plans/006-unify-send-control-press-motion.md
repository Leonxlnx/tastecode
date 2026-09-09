# 006 — Unify send-control press motion

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: MEDIUM
- **Category**: Physicality and cohesion
- **Estimated scope**: 4 files, about 80 lines

## Problem

The main send button stays enlarged at `scale(1.05)` while pressed because its `:active` rule does
not set transform. Stop shrinks to `0.92`, the pull-request sender shrinks to `0.94`, and side chat
has no press state or transform transition. Their hover movement is also not limited to devices with
a precise pointer.

```css
/* apps/web/src/styles/app.css:9228 — current */
.orb:hover:not(:disabled):not(.orb--stop) {
  background: var(--composer-orb);
  transform: scale(1.05);
}
.orb:active:not(:disabled):not(.orb--stop) {
  box-shadow: inset 0 1px 0 rgba(0, 0, 0, 0.08);
}
.orb--stop:hover:not(:disabled) {
  background: color-mix(in srgb, var(--composer-stop) 82%, var(--text));
  transform: scale(1.05);
}
.orb--stop:active {
  transform: scale(0.92);
}

/* apps/web/src/ui/pull-requests/pull-requests.css:1699 — current */
.pr-send-button:hover:not(:disabled) {
  background: var(--composer-orb);
  transform: scale(1.05);
}
.pr-send-button:active:not(:disabled) {
  box-shadow: inset 0 1px 0 rgb(0 0 0 / 8%);
  transform: scale(0.94);
}

/* apps/web/src/ui/workspace-panel.css:1276 — current */
.workspace-side-chat__composer button {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: grid;
  width: 27px;
  height: 27px;
  place-items: center;
  padding: 0;
  background: var(--text);
  border: 0;
  border-radius: var(--r-pill);
  color: var(--bg);
  cursor: pointer;
}
.workspace-side-chat__composer button:not(:disabled):hover {
  transform: scale(1.04);
}
```

## Target

Every send or stop control uses `scale(0.97)` on press with the repo's 140ms ease-out. Existing hover
scale values may stay, but hover movement must be inside a precise-pointer media query. Reduced
motion removes scale while retaining non-spatial state color where available.

```css
/* target pattern */
.send-control {
  transition: transform var(--dur-press) var(--ease-out);
}

@media (hover: hover) and (pointer: fine) {
  .send-control:hover:not(:disabled) {
    transform: scale(1.05);
  }
}

.send-control:active:not(:disabled) {
  transform: scale(0.97);
}

@media (prefers-reduced-motion: reduce) {
  .send-control:active:not(:disabled) {
    transform: none;
  }
}
```

## Repo conventions to follow

- `apps/web/src/styles/app.css:9068` defines `.btn` press feedback as
  `transform var(--dur-press) var(--ease-out)` and `scale(0.97)`. Match it exactly.
- `apps/web/src/styles/app.css:17` gates the global 3-degree icon hover with
  `@media (hover: hover) and (pointer: fine)` and uses independent `rotate`. Preserve that rule.
- Keep each control's existing background, color, box-shadow, disabled, and pending states.

## Steps

1. In `apps/web/src/styles/app.css`, move the two orb hover rules into one
   `@media (hover: hover) and (pointer: fine)` block without changing their colors or `scale(1.05)`.
2. Set both main-send and stop `:active:not(:disabled)` transforms to `scale(0.97)`. Add
   `:not(:disabled)` to the stop selector. Keep their active box shadows.
3. In the existing orb reduced-motion block, set both active transforms to `none`; do not restore
   any icon movement.
4. In `apps/web/src/ui/pull-requests/pull-requests.css`, change the transform part of
   `.pr-send-button` to `var(--dur-press) var(--ease-out)`, gate its hover rule with the precise
   pointer query, and change active scale to `0.97`.
5. Add a reduced-motion rule for the PR sender that removes active transform. Keep background,
   box-shadow, and color state rules.
6. In `apps/web/src/ui/workspace-panel.css`, add
   `transition: transform var(--dur-press) var(--ease-out)` to the side-chat sender, gate its current
   hover rule, add `:active:not(:disabled) { transform: scale(0.97); }`, and remove that transform in
   reduced motion.
7. Add `apps/web/src/styles/send-control-motion.test.ts`. Read all three CSS files. Assert a
   `scale(0.97)` active state for each control, no `0.92` or `0.94` send/stop scale, precise-pointer
   gates around hover transforms, and reduced-motion transform removal.

## Boundaries

- Do NOT change sizes, icons, labels, callbacks, disabled logic, send/stop behavior, or pending state.
- Do NOT alter the global icon tilt or replace independent `rotate` with `transform`.
- Do NOT force all hover scales to the same value; only press scale and timing are shared.
- Do NOT add a dependency.
- If a cited control no longer exists after commit `bfc88477`, STOP and report the drift. Line-only
  movement caused by earlier plans is not semantic drift.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/send-control-motion.test.ts src/ui/Composer.test.tsx src/ui/pull-requests/PullRequestDetailPane.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Press main Send, Stop, PR Send, and side-chat Send with a mouse. Each must feel like
  the same shallow `0.97` press and recover in 140ms. Emulate touch: hover growth must not stick after
  a tap. Enable reduced motion: no control may scale, but state color must remain clear.
- **Done when**: All four controls have the same press depth and timing, and hover movement is
  precise-pointer only.
