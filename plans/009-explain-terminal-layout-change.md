# 009 — Explain the terminal layout change

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: MEDIUM
- **Category**: Missed opportunities
- **Estimated scope**: 5 files, about 130 lines

## Problem

Toggling the terminal changes the stage from two grid rows to three in one render. The terminal child
only fades and moves 8px, so that small local animation does not explain the much larger thread
viewport change.

```tsx
// apps/web/src/App.tsx:3585 and 4068 — current
const toggleTerminal = useCallback(() => setTerminalOpen((open) => !open), [])
const closeTerminal = useCallback(() => setTerminalOpen(false), [])

// apps/web/src/App.tsx:4068 — current
className={`stage__body${activeId ? '' : ' is-new-session'}${active && terminalOpen ? ' has-terminal' : ''}`}

// apps/web/src/App.tsx:4110 — current
{active && terminalOpen ? (
  <Suspense fallback={null}>
    <components.TerminalPane
      key={activeId}
      transport={transport}
      threadId={active.session.id}
      height={terminalHeight}
      theme={theme}
      onHeightChange={setTerminalHeight}
      onClose={closeTerminal}
    />
  </Suspense>
) : null}
```

```css
/* apps/web/src/styles/app.css:4240 and 4426 — current */
.stage__body {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  border-top-left-radius: inherit;
}

.stage__body.has-terminal {
  grid-template-rows: minmax(0, 1fr) auto auto;
}

.terminal-pane {
  position: relative;
  display: flex;
  min-height: 160px;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
  border-top: 1px solid var(--line);
  /* It was the only surface in the app that opened with no transition: the
     composer jumped up its full height in a single frame. */
  animation: terminal-in 200ms var(--ease-out) both;
}

@keyframes terminal-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

## Target

Use the browser View Transition API to snapshot the thread, terminal, and composer around this rare
layout change. Animate snapshot transforms/opacity only; never transition grid tracks, height, or
width. The terminal enters from `translateY(100%)` with opacity 0 and exits in reverse. Moving
snapshots use 260ms and the exact strong ease-in-out curve. Feature detection and reduced motion must
fall back to the current immediate state update.

```css
/* apps/web/src/styles/tokens.css — target */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);

/* apps/web/src/styles/app.css — target */
.stage__body > .thread-shell {
  view-transition-name: terminal-thread;
}
.stage__body > .terminal-pane {
  view-transition-name: terminal-pane;
}
.stage__body > .composer {
  view-transition-name: terminal-composer;
}

::view-transition-group(terminal-thread),
::view-transition-group(terminal-pane),
::view-transition-group(terminal-composer) {
  animation-duration: var(--dur-slow);
  animation-timing-function: var(--ease-in-out);
}

::view-transition-new(terminal-pane) {
  animation: terminal-view-in var(--dur-slow) var(--ease-out) both;
}
::view-transition-old(terminal-pane) {
  animation: terminal-view-out var(--dur-slow) var(--ease-out) both;
}
@keyframes terminal-view-in {
  from {
    opacity: 0;
    transform: translateY(100%);
  }
}
@keyframes terminal-view-out {
  to {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

## Repo conventions to follow

- `apps/web/src/ui/Composer.tsx:505` is the local FLIP exemplar: capture old/new geometry, animate
  transform only, cancel stale work, and branch on reduced motion.
- Add `--ease-in-out` beside `--ease-out` in `apps/web/src/styles/tokens.css` with the exact
  `cubic-bezier(0.77, 0, 0.175, 1)` value from the audit rules.
- Use `--dur-slow: 260ms`. The terminal is occasional UI, and 260ms stays below the 300ms UI budget.

## Steps

1. Add the exact `--ease-in-out` token above to `apps/web/src/styles/tokens.css`.
2. In `apps/web/src/App.tsx`, import `flushSync` from `react-dom`. Add a ref for the active
   `ViewTransition` so a later toggle can call `skipTransition()` before starting another.
3. Replace direct terminal state setters with one `changeTerminalOpen` callback that accepts a
   boolean or updater. If reduced motion matches, `document.startViewTransition` is absent, or there
   is no active session, update state directly. Otherwise skip the prior transition and call
   `document.startViewTransition(() => flushSync(() => setTerminalOpen(update)))`.
4. Store the returned transition. Clear the ref from `transition.finished.finally(...)` only if it is
   still the same transition. Derive `toggleTerminal` and `closeTerminal` from this callback. Preserve
   the existing persisted `terminalOpen` state and every caller.
5. Add the three `view-transition-name` rules and pseudo-element rules shown in Target to
   `apps/web/src/styles/app.css`. Add `terminal-view-in` and `terminal-view-out` exactly as shown.
6. Remove the current `.terminal-pane` `terminal-in` animation and old keyframes so the live element
   does not double-animate with its snapshot.
7. Add a reduced-motion rule that sets those three `view-transition-name` values to `none`. The JS
   branch must also bypass `startViewTransition`.
8. Extend `apps/web/src/App.test.tsx`: mock `document.startViewTransition`, run its update callback,
   and verify Open terminal and Close terminal each use it and still mount/unmount the same pane.
   Verify a second toggle calls `skipTransition` on the first. Mock reduced motion and verify the API
   is not called.
9. Add `apps/web/src/styles/terminal-motion.test.ts`. Assert the exact token, names, 260ms group
   timing, 100% terminal translation, reduced-motion removal, absence of `terminal-in`, and absence
   of any transition on `grid-template-rows`, height, or width inside the stage, terminal, and
   terminal view-transition rules.

## Boundaries

- Do NOT animate real grid tracks, height, width, margin, padding, top, left, or terminal resize.
- Do NOT remount Thread or Composer, change terminal persistence, alter xterm setup, or add wrappers.
- Do NOT start a document transition when reduced motion is enabled or the API is unavailable.
- Do NOT add a dependency; `react-dom` is already installed.
- If the terminal state or direct-child classes changed after commit `bfc88477`, STOP and report
  semantic drift. Line-only movement from earlier plans is safe.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/terminal-motion.test.ts src/App.test.tsx src/ui/TerminalPane.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Use the packaged Electron dev shell, not only a browser tab. Open and close the
  terminal repeatedly while the thread is scrolled to the bottom and while output streams. At 10%
  playback, the terminal must travel from its own full height, and thread/composer snapshots must
  move without a one-frame jump or double exposure. Confirm xterm text stays sharp after completion.
  Reduced motion and an API-disabled DevTools override must both switch state immediately. On a
  long thread, the toggle must not add a main-thread task longer than 50ms.
- **Done when**: Terminal layout changes are spatially explained through snapshots, no real layout
  property animates, and all fallback paths keep existing behavior.
