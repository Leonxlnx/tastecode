# 001 — Stop animating composer height

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 3 files, about 30 lines

## Problem

Both prompt fields calculate a new pixel height after each draft change, then CSS animates that
layout property for 180ms. The JavaScript must read layout once to autosize, but the CSS transition
extends layout and paint work across more frames on the hottest input path in the app.

```tsx
// apps/web/src/ui/Composer.tsx:555 — current
el.style.height = 'auto'
const nextHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT))
el.style.height = `${nextHeight}px`
```

```css
/* apps/web/src/styles/app.css:7010 — current */
.composer textarea {
  display: block;
  width: 100%;
  background: none;
  border: 0;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 1.55;
  min-height: 68px;
  padding: 16px 18px 8px;
  resize: none;
  outline: none;
  max-height: 242px;
  overflow-y: hidden;
  transition: height var(--dur-fast) var(--ease-out);
}

/* apps/web/src/ui/pull-requests/pull-requests.css:1610 — current */
.pr-composer textarea {
  display: block;
  width: 100%;
  min-height: 62px;
  max-height: 160px;
  padding: 14px 16px 8px;
  overflow-y: auto;
  resize: none;
  background: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 1.55;
  outline: 0;
  appearance: none;
  transition: height var(--dur-fast) var(--ease-out);
}
```

## Target

Keep both existing autosize implementations. Remove only the two `height` transitions. A draft
change must set the final textarea height in the same frame, with no wrapper animation and no new
duration or easing.

```css
/* target in both textarea rules */
.composer textarea,
.pr-composer textarea {
  /* no transition on height */
}
```

## Repo conventions to follow

- Motion tokens live in `apps/web/src/styles/tokens.css`; this fix does not add a token.
- `apps/web/src/styles/tool-call-disclosure-motion.test.ts:12` uses a static CSS contract to reject
  layout animation. Use the same `readFileSync(new URL(...))` test style.
- Keep the current `requestAnimationFrame` batching in `Composer.tsx`; it limits autosize writes and
  is separate from this CSS problem.

## Steps

1. In `apps/web/src/styles/app.css`, delete only
   `transition: height var(--dur-fast) var(--ease-out);` from `.composer textarea`.
2. In `apps/web/src/ui/pull-requests/pull-requests.css`, delete the same declaration from
   `.pr-composer textarea`.
3. Add `apps/web/src/styles/composer-height-motion.test.ts`. Read both CSS files, extract the two
   textarea rules, and assert that neither contains `transition:` or `animation:`. Also assert that
   their existing `min-height` and `max-height` values remain unchanged.

## Boundaries

- Do NOT change either autosize function, textarea limits, draft state, or send behavior.
- Do NOT animate a wrapper to replace the removed transition.
- Do NOT touch unrelated composer motion such as the existing new-session FLIP.
- Do NOT add a dependency.
- If the cited declarations are already gone or the autosize path changed after commit `bfc88477`,
  STOP and report the drift instead of improvising.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/composer-height-motion.test.ts src/ui/Composer.test.tsx src/ui/pull-requests/PullRequestDetailPane.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Use the existing `pnpm dev` app. Type and delete 10 lines quickly in the main
  composer and the pull-request comment composer. Both fields must track the text immediately and
  must not trail behind the last key. In DevTools Performance, one autosize layout read per change
  is acceptable; there must be no 180ms tail of layout work after the key event.
- **Done when**: Both composers still autosize to the same limits, and neither CSS rule can animate
  height.
