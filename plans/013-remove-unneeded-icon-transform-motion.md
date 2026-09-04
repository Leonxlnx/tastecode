# 013 — Remove unneeded icon transform motion

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: MEDIUM
- **Category**: hover motion
- **Estimated scope**: 3 files, about 30 lines

## Problem

A broad SVG hover rule made provider marks, chevrons, and spinners tilt by 3 degrees. Audit edits have
removed that rule, but the corrected boundary needs a regression test. The fast-mode icon also carried
a dead rotate transition although its state changes only fill.

```css
/* apps/web/src/styles/app.css:19 — current corrected boundary */
:where(svg.tabler-icon, svg[width][height], svg[aria-hidden='true']) {
  transform-origin: center;
}
```

```css
/* apps/web/src/styles/model-selector-menu.css:44 — current corrected boundary */
.model-selector__fast-icon svg {
  fill: transparent;
  transition: fill var(--dur-fast) var(--ease-out);
}
```

## Target

Keep icons still on generic hover. Do not add `transform`, `rotate`, or transform transitions to the
broad SVG selector. Keep fast-mode icon feedback limited to fill. Scoped icon motion may exist only
where a component explicitly owns and tests it.

## Repo conventions to follow

- Use color, background, opacity, and small control-scale feedback already defined per component.
- `apps/web/src/styles/fast-mode-motion.test.ts` owns fast-mode motion behavior.

## Steps

1. Keep the removed global SVG hover transform and transition absent from `app.css`.
2. Keep the fast-mode SVG transition limited to `fill` in `model-selector-menu.css`.
3. Extend the relevant style tests to reject a broad SVG `:hover` transform and any fast-mode rotate transition.

## Boundaries

- Do NOT remove scoped icon motion that has a component-specific purpose.
- Do NOT change icon size, color, or markup.
- Do NOT add dependencies.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/styles/fast-mode-motion.test.ts apps/web/src/styles/model-selector-theme.test.ts apps/web/src/styles/hover-gating.test.ts` passes.
- **Feel check**: hover sidebar controls, provider marks, model chevrons, and the send control. Icons
  stay geometrically still while their existing color/background feedback remains smooth.
- **Done when**: a 120Hz trace shows no icon rotation on generic hover and focused controls remain visible.
