# 002 — Make keyboard search motion instant

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: HIGH
- **Category**: Purpose and frequency
- **Estimated scope**: 2 files, about 45 lines

## Problem

The command palette, chat search, and in-thread find are keyboard-first surfaces. Their repeated
selection and opening states still use 180ms motion. Arrow navigation changes `.is-selected` on
every key press, so two rows paint a background, border, and shadow transition each time.

```css
/* apps/web/src/styles/app.css:2762 — current */
.command-palette__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  border: 0;
  cursor: default;
  animation: fade-in var(--dur-fast) var(--ease-out);
}
.command-palette__panel {
  position: relative;
  width: min(560px, 100%);
  overflow: hidden;
  background: var(--bg-rail);
  border: 1px solid var(--chrome-border);
  border-radius: var(--r-dialog);
  box-shadow: var(--chrome-shadow), var(--shadow-modal);
  animation: step-in 220ms var(--ease-out);
}
.command-palette__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 7px 8px;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--r-popup-item);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

/* apps/web/src/styles/app.css:2947 — current */
.session-search__result {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--r-popup-item);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}

/* apps/web/src/styles/app.css:6318 — current */
.find {
  position: absolute;
  top: 10px;
  right: 22px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 10px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-flyout);
  animation: menu-in var(--dur-fast) var(--ease-out);
}
```

`step-in` has no current `@keyframes` definition, so that declaration is also dead code.

## Target

Opening these three keyboard surfaces and moving their selected row must be instant. Preserve the
pointer press on a chat-search result by keeping only the transform transition used by `:active`.

```css
/* target */
.command-palette__scrim,
.command-palette__panel,
.command-palette__item,
.find {
  /* no entry animation and no selection transition */
}

.session-search__result {
  transition: transform var(--dur-press) var(--ease-out);
}
```

## Repo conventions to follow

- `apps/web/src/styles/app.css:8174` already limits generic menu entry motion to
  `.menu.is-positioned[data-input-modality='pointer']`. Do not weaken that pointer-only behavior.
- Use `--dur-press: 140ms` and `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` only for the retained
  pointer press. Do not add a new token.
- Keep `CommandPalette.tsx` and `SessionSearch.tsx` selection logic unchanged.

## Steps

1. Remove the `animation` declarations from `.command-palette__scrim`,
   `.command-palette__panel`, and `.find` in `apps/web/src/styles/app.css`.
2. Remove the full transition block from `.command-palette__item`.
3. Replace the four-property transition on `.session-search__result` with exactly
   `transition: transform var(--dur-press) var(--ease-out);` so its pointer `:active` feedback stays.
4. Add `apps/web/src/styles/keyboard-search-motion.test.ts`. Read `app.css` and assert that the
   palette scrim, palette panel, palette item, and find rules contain no `animation`; assert that the
   palette item has no `transition`; assert that the chat-search result transitions only transform.
5. In the same test, assert that the pointer-only generic menu rule at `app.css:8174` still uses
   `menu-in var(--dur-fast) var(--ease-out)`.

## Boundaries

- Do NOT change shortcuts, focus, selection, scrolling, or result ordering.
- Do NOT remove `.session-search__result:active` or its `translateY(1px)` press.
- Do NOT restore `@keyframes step-in` here; plan 007 gives sheets their own animation name.
- Do NOT change the pointer-only generic `Menu` component.
- Do NOT add a dependency.
- If the cited rules differ after commit `bfc88477`, STOP and report the drift.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/keyboard-search-motion.test.ts src/ui/CommandPalette.test.tsx src/ui/SessionSearch.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Open command palette with Cmd/Ctrl+K, chat search with Cmd/Ctrl+Shift+F, and thread
  find with Cmd/Ctrl+F. At normal speed and at 10% DevTools playback, opening and repeated Arrow
  Up/Down must have no fade, shadow trail, or delayed highlight. A mouse press on a chat-search row
  must still move down by 1px and settle in 140ms.
- **Done when**: All three keyboard surfaces respond in the same frame, while pointer-only generic
  menus and chat-search press feedback retain their existing motion.
