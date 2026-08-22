import { lazy } from 'react'
import type { ThreadProps } from './Thread.js'

let threadModulePromise: Promise<typeof import('./Thread.js')> | undefined

function loadThread() {
  threadModulePromise ??= import('./Thread.js').catch((error: unknown) => {
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

export function LazyThread(props: ThreadProps) {
  return <Thread {...props} />
}
