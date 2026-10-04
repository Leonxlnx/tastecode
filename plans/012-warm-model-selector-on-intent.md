# 012 — Warm model picker on intent

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: HIGH
- **Category**: interaction latency
- **Estimated scope**: 4 files, about 45 lines

## Problem

The model panel correctly stays out of the startup bundle, but the first click pays its full import
cost. A fresh Electron trace measured the loading shell at 3.4ms and the real search field at 304.6ms.
The first implementation called the same loader function from intent and React lazy, but each call
created a new chained promise. Even after 1.5 seconds of pointer intent, live Electron still showed
the Loading models fallback and the search field at 307.7ms. Caching that exact promise still measured
310.1ms. React lazy stays uninitialized until its first render, so it suspends once even when the
module promise is already fulfilled. The resolved component must also be cached and used directly.

```tsx
/* apps/web/src/ui/ModelSelector.tsx:15 — current */
const ModelSelectorPanel = lazy(() =>
  import('./ModelSelectorPanel.js').then((module) => ({
    default: module.ModelSelectorPanel,
  })),
)
```

```tsx
/* apps/web/src/ui/Menu.tsx:33 — current */
type MenuBaseProps = {
  children: (close: () => void) => ReactNode
  disabled?: boolean
  onOpen?: (() => void) | undefined
}
```

## Target

Keep `ModelSelectorPanel` lazy for cold clicks. Cache one module-scoped panel promise and one resolved
panel component. Make `loadModelSelectorPanel` return the exact promise and save
`module.ModelSelectorPanel` when it resolves. When Menu later calls its child renderer, render the
resolved component directly if it exists; otherwise render the lazy component inside Suspense. Use
the loader for `onTriggerIntent`. A normal menu trigger calls it on `pointerenter` and `focus` when enabled.

## Repo conventions to follow

- `Menu.tsx` owns shared trigger behavior.
- `apps/web/src/styles/startup-css-budget.test.ts` protects the lazy model-selector boundary.
- The cached promise must use a type-only `typeof import('./ModelSelectorPanel.js')` reference so the
  panel stays out of the startup runtime bundle.

## Steps

1. Add `onTriggerIntent?: (() => void) | undefined` to `MenuBaseProps`.
2. On the regular trigger button, call `props.onTriggerIntent?.()` from `onPointerEnter` and
   `onFocus` only when `props.disabled` is false.
3. In `ModelSelector.tsx`, add a module-scoped `modelSelectorPanelPromise` and make
   `loadModelSelectorPanel` initialize it with `??=`. Save the resolved panel component in the same
   `.then` callback. Pass the loader to `lazy` and Menu intent.
4. In the Menu child renderer, read the resolved module-scoped component at call time. Render it
   directly when available; otherwise keep the existing lazy component and fallback path.
5. Update the `ModelSelector.test.tsx` Menu mock to expose and test the intent callback.
6. Add a `Menu.test.tsx` case that covers pointer, focus, disabled, and context-only behavior.
7. Extend the static startup test to require promise and resolved-component memoization while proving
   `ModelSelectorPanel` is still dynamically imported.

## Boundaries

- Do NOT eagerly import `ModelSelectorPanel`.
- Do NOT preload every lazy panel at app startup.
- Do NOT change menu opening, focus, or dismissal behavior.
- Do NOT add timers or dependencies.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/ui/Menu.test.tsx apps/web/src/ui/ModelSelector.test.tsx apps/web/src/styles/startup-css-budget.test.ts` passes.
- **Feel check**: after a fresh reload, move the pointer onto the model trigger, pause 350ms, then
  click. The real picker appears with no visible Loading models state. Keyboard focus warms the same path.
- **Done when**: the model selector stays out of the startup bundle and intent-warmed first open makes
  the search field ready within 50ms of the click with no visible fallback.
