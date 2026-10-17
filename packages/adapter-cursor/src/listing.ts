import type { runCli } from '@harness/proc'
import { runCursorAgent } from './launch.js'

type Run = typeof runCli
type ModelsOutput = Awaited<ReturnType<Run>>

/**
 * How long `cursor-agent models` may take. It starts node and fetches the
 * account's models before it prints anything: 1.6 s on a quiet machine, 12.6 s
 * on a cold start and 9–14.5 s on a busy one, and longer still with the CPU
 * pinned. The listing runs behind the last list the app already has, so a slow
 * answer costs a waiting process, while one cut off leaves Cursor with no
 * models at all.
 */
export const CURSOR_MODELS_TIMEOUT_MS = 60_000

/** How long a listing that answered also answers the next sign-in check or picker. */
const ANSWERED_SHARE_MS = 60_000

type SharedListing = { output: Promise<ModelsOutput>; sharedUntil: number }

/**
 * The newest `models` read per runner. The built-in runner is one function,
 * so the sign-in check and every picker share its reads; a custom harness
 * brings its own runner and binary and never borrows that answer.
 */
let listings = new WeakMap<Run, SharedListing>()

/**
 * One `cursor-agent models` read for everyone who asks at once: a read under
 * way, or one that answered in the last minute, before another node starts. A
 * refused or failed read is never reused, so a sign-in finished in Cursor
 * shows at the next check.
 */
export function readCursorModels(run: Run = runCursorAgent): Promise<ModelsOutput> {
  const current = listings.get(run)
  if (current && current.sharedUntil > Date.now()) return current.output
  let output: Promise<ModelsOutput>
  try {
    output = run('cursor-agent', ['models'], CURSOR_MODELS_TIMEOUT_MS)
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  const listing: SharedListing = { output, sharedUntil: Number.POSITIVE_INFINITY }
  listings.set(run, listing)
  output.then(
    (result) => {
      if (listings.get(run) !== listing) return
      if (result.code === 0) listing.sharedUntil = Date.now() + ANSWERED_SHARE_MS
      else listings.delete(run)
    },
    () => {
      if (listings.get(run) === listing) listings.delete(run)
    },
  )
  return output
}

export function resetCursorModelsForTests(): void {
  listings = new WeakMap()
}
