import { lazy, memo } from 'react'
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
