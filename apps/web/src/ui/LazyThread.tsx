import { lazy, memo } from 'react'
import type { BriefProps } from './BriefView.js'
import type { ThreadProps } from './Thread.js'

let threadModulePromise: Promise<typeof import('./Thread.js')> | undefined
let threadModule: typeof import('./Thread.js') | undefined

function loadThread() {
  threadModulePromise ??= import('./Thread.js')
    .then((module) => {
      threadModule = module
      return module
    })
    .catch((error: unknown) => {
      threadModulePromise = undefined
      throw error
    })
  return threadModulePromise
}

const Thread = lazy(() =>
  loadThread().then((module) => ({
    default: module.Thread,
  })),
)

export function preloadThread(): void {
  if (threadModulePromise) return
  void loadThread().catch(() => undefined)
}

export const LazyThread = memo(function LazyThread(props: ThreadProps) {
  const LoadedThread = threadModule?.Thread
  if (LoadedThread) return <LoadedThread {...props} />
  return <Thread {...props} />
})

// The Brief view is a prototype behind a setting: its own chunk, loaded only
// when a chat is shown as a Brief.
let briefModulePromise: Promise<typeof import('./BriefView.js')> | undefined
let briefModule: typeof import('./BriefView.js') | undefined

function loadBrief() {
  briefModulePromise ??= import('./BriefView.js')
    .then((module) => {
      briefModule = module
      return module
    })
    .catch((error: unknown) => {
      briefModulePromise = undefined
      throw error
    })
  return briefModulePromise
}

const Brief = lazy(() => loadBrief().then((module) => ({ default: module.BriefView })))

/** Warm the Brief's chunk when its switch appears, so the first switch is instant. */
export function preloadBrief(): void {
  if (briefModulePromise) return
  void loadBrief().catch(() => undefined)
}

export const LazyBrief = memo(function LazyBrief(props: BriefProps) {
  const LoadedBrief = briefModule?.BriefView
  if (LoadedBrief) return <LoadedBrief {...props} />
  return <Brief {...props} />
})
