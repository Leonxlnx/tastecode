# 008 — Animate notice presence

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: MEDIUM
- **Category**: Missed opportunities
- **Estimated scope**: 4 files, about 150 lines

## Problem

Connection and action notices mount and unmount directly. The CSS has no entry or exit state, so an
important error, success, or reconnect message teleports at the lower-right corner.

```tsx
// apps/web/src/App.tsx:4328 — current
{
  offline ? (
    <div className="notice notice--offline" role="status">
      <LoaderCircle className="spinner" size={12} aria-hidden />
      <span className="notice__text">Reconnecting to the server…</span>
    </div>
  ) : null
}

{
  notice ? (
    <div
      className={`notice${undoRestore || notice === 'Restore undone.' ? ' notice--success' : ''}`}
      role="alert"
    >
      <span className="notice__text">{notice}</span>
      {undoRestore ? (
        <button className="ghost" onClick={() => void reverseRestore()}>
          Undo restore
        </button>
      ) : null}
      <button
        className="ghost"
        onClick={() => {
          setNotice(undefined)
          setUndoRestore(undefined)
        }}
      >
        Dismiss
      </button>
    </div>
  ) : null
}
```

```css
/* apps/web/src/styles/app.css:9403 — current */
.notice {
  position: fixed;
  /* Above every modal surface (settings 60, palette 70, image viewer 100) —
     an error raised while one of them is open must still be visible. */
  z-index: 110;
  bottom: 18px;
  right: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(420px, calc(100vw - 36px));
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-card);
  padding: 9px 10px;
  font-size: var(--t-sm);
}
```

## Target

Use one reusable presence component for both notices. Entry and exit must be interruptible CSS
transitions: 180ms in, 140ms out, strong ease-out, opacity plus a 4px rise and `scale(0.97)`. Closing
keeps the last content mounted and non-interactive until its opacity transition ends. If a notice
reopens during close, it retargets from its current state. Reduced motion keeps the same opacity
timing but removes transform.

```css
/* target */
.notice {
  opacity: 1;
  transform: translateY(0) scale(1);
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

@starting-style {
  .notice[data-state='open'] {
    opacity: 0;
    transform: translateY(4px) scale(0.97);
  }
}

.notice[data-state='closing'] {
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px) scale(0.97);
  transition-duration: var(--dur-press);
}

@media (prefers-reduced-motion: reduce) {
  .notice {
    transform: none;
    transition: opacity var(--dur-fast) var(--ease-out) !important;
  }
  @starting-style {
    .notice[data-state='open'] {
      opacity: 0;
      transform: none;
    }
  }
  .notice[data-state='closing'] {
    opacity: 0;
    transform: none;
    transition-duration: var(--dur-press) !important;
  }
}
```

## Repo conventions to follow

- Use `--dur-fast: 180ms`, `--dur-press: 140ms`, and
  `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` from `styles/tokens.css:204`.
- `apps/web/src/ui/Thread.tsx:987` keeps disclosure content mounted through a `closing` phase and
  completes on the end event. Follow that phase pattern, but use transitions so a reopen retargets.
- Keep the existing notice roles: offline is `status`; action/error notice is `alert`.

## Steps

1. Add `apps/web/src/ui/NoticePresence.tsx`. Export a component with this exact public shape:
   `visible: boolean`, `className: string`, `role: 'alert' | 'status'`, and `children: ReactNode`.
2. Inside it, keep the most recent visible `{ className, role, children }` in a ref. Use
   `mounted: boolean` and phase `'open' | 'closing'`. When `visible` becomes true, mount and set
   `open`; when false, keep the snapshot mounted and set `closing`.
3. Render one `<div>` with the saved class, role, and `data-state`. On its own `opacity`
   `transitionend`, unmount only when phase is `closing` and `visible` is still false. Ignore bubbled
   child events and other transition properties. If `visible` becomes true before that event, set
   `open` and do not unmount.
4. Replace both conditional notice blocks in `apps/web/src/App.tsx` with always-rendered
   `NoticePresence` calls using `visible={offline}` and `visible={Boolean(notice)}`. Preserve their
   exact children, roles, class names, Dismiss action, Undo restore action, and z-index order.
5. Add the exact CSS in Target to `apps/web/src/styles/app.css` after the current `.notice` rules.
6. Add `apps/web/src/ui/NoticePresence.test.tsx`. Test initial hidden, initial visible, visible to
   closing, removal only after the root opacity transition ends, child-event rejection, and reopening
   before close completion. Read `app.css` in the same test and assert reduced motion uses opacity
   only.

## Boundaries

- Do NOT change notice text, timeout length, role, live-region behavior, button actions, or stacking.
- Do NOT use keyframes, JavaScript timers, a motion library, or animated layout properties.
- Do NOT let a closing notice accept pointer input.
- Do NOT merge offline and action notices into one slot; they can be visible together.
- If notice state or markup changed after commit `bfc88477`, STOP and report semantic drift. Line-only
  movement from earlier plans is safe.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/ui/NoticePresence.test.tsx src/App.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Trigger an error notice, dismiss it, then trigger another before the first exit
  finishes. Disconnect and reconnect the dev server to check the offline notice. At 10% playback,
  entry must rise only 4px from `0.97`; exit must reverse without a jump. Reduced motion must show a
  short opacity-only handoff. Screen-reader roles must announce exactly as before.
- **Done when**: Both notice types enter, exit, and reverse cleanly while their behavior and content
  stay unchanged.
