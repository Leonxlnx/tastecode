import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ComposerError } from './ui/ComposerErrors.js'

/** Stands for a callback in a notice's data key; no message holds a NUL character. */
const CALLBACK = '\u0000callback'

type Committed = { readonly current: ReadonlyMap<string, ComposerError> }

/**
 * One identity for the composer's notices while what they show stays the
 * same: a list rebuilt on every App render re-rendered the memoized composer
 * with each of them. The kept notices own no callbacks of their own. Each one
 * calls the callback of the notice with its id (and of the choice with its id)
 * in the list the last commit showed. A render that never commits cannot
 * change what a visible button does, a notice that is gone does nothing, and
 * an old button never reaches into a newer list by position.
 */
export function useStableNotices(notices: readonly ComposerError[]): readonly ComposerError[] {
  const committed = useRef<ReadonlyMap<string, ComposerError>>(new Map())
  useLayoutEffect(() => {
    committed.current = new Map(notices.map((notice) => [notice.id, notice]))
  })
  const key = JSON.stringify(notices, (_name, value: unknown) =>
    typeof value === 'function' ? CALLBACK : value,
  )
  // The key carries every value of `notices` the kept list shows.
  return useMemo(() => notices.map((notice) => owned(notice, committed)), [key])
}

function owned(notice: ComposerError, committed: Committed): ComposerError {
  const current = () => committed.current.get(notice.id)
  const { action, choices, usageReset, report, dismiss } = notice
  return {
    ...notice,
    ...(action ? { action: { label: action.label, run: () => current()?.action?.run() } } : {}),
    ...(choices
      ? {
          choices: {
            label: choices.label,
            options: choices.options.map((option) => ({
              ...option,
              run: () =>
                current()
                  ?.choices?.options.find((choice) => choice.id === option.id)
                  ?.run(),
            })),
          },
        }
      : {}),
    ...(usageReset
      ? {
          usageReset: {
            ...usageReset,
            schedule: () => current()?.usageReset?.schedule() ?? Promise.resolve(),
            cancel: () => current()?.usageReset?.cancel(),
          },
        }
      : {}),
    ...(report ? { report: () => current()?.report?.() } : {}),
    ...(dismiss ? { dismiss: () => current()?.dismiss?.() } : {}),
  }
}
