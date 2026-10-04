# 019 — Render prepared surfaces directly

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: HIGH
- **Category**: interaction latency
- **Estimated scope**: 2 files, about 65 lines

## Problem

Terminal and workspace buttons already import their lazy modules on pointer entry and focus, but the
prepared module is discarded. React lazy remains uninitialized until click, suspends once, and keeps
the real surface behind its fallback for about 300ms. Live Electron traces after 600ms of true intent
measured terminal shell at 4.9ms but xterm at 324.2ms, and workspace layout open at 13.8ms but the
panel at 315ms.

```tsx
/* apps/web/src/App.tsx:242 — current */
const loadTerminalPane = () => import('./ui/TerminalPane.js')
const TerminalPane = lazy(() =>
  loadTerminalPane().then((module) => ({ default: module.TerminalPane })),
)

const loadWorkspacePanel = () => import('./ui/workspace/WorkspacePanel.js')
const WorkspacePanel = lazy(() =>
  loadWorkspacePanel().then((module) => ({ default: module.WorkspacePanel })),
)
```

## Target

Keep both surfaces out of the startup runtime bundle. For each surface, cache one module-scoped lazy
promise and the resolved component in its `.then` callback. The existing pointer/focus preparation
calls the cached loader. On the click-driven App rerender, choose the resolved component directly if
available; otherwise use the existing lazy component and Suspense fallback for a cold activation.

## Repo conventions to follow

- Copy the proven resolved-component pattern from `apps/web/src/ui/ModelSelector.tsx`.
- `PanelToggles` already calls `onPrepareTerminal` and `onPrepareWorkspace` on pointer entry and focus.
- Use `typeof import(...)` only as a type so there is no eager runtime import.

## Steps

1. Replace the raw terminal loader with a memoized promise that stores the resolved `TerminalPane`.
2. Replace the raw workspace loader with the same pattern for `WorkspacePanel`.
3. Inside `App`, select resolved-or-lazy component variables on each render and use them at the
   existing Suspense sites. Do not change props, fallback markup, or mounted-state logic.
4. Extend `startup-css-budget.test.ts` to require both dynamic imports, cached promises, resolved
   components, and resolved-or-lazy render variables. Reject static runtime imports.

## Boundaries

- Do NOT preload either module at app startup or on an idle timer.
- Do NOT mount xterm or workspace DOM before the user activates it.
- Do NOT change terminal process lifecycle, workspace state, or animation values.
- Do NOT add dependencies.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/styles/startup-css-budget.test.ts apps/web/src/ui/StageHeader.test.tsx apps/web/src/App.test.tsx` passes; web typecheck and Prettier pass.
- **Feel check**: after a clean reload, move onto the terminal button for 600ms and click; repeat for
  workspace. The real surface appears in the same opening sequence with no 300ms empty shell.
- **Done when**: prepared terminal xterm and prepared workspace panel both mount within 50ms of click,
  their requestAnimationFrame traces have no frame above 33.3ms, and cold activation still has a safe fallback.
