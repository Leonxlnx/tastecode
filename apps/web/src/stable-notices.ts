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
  const committed = useRef<ReadonlyMap<string, ComposerError>>(NONE)
  useLayoutEffect(() => {
    committed.current = new Map(notices.map((notice) => [notice.id, notice]))
    // Unmounted, a kept notice does nothing and holds no callback of the last list.
    return () => {
      committed.current = NONE
    }
  })
  const key = JSON.stringify(notices, (_name, value: unknown) =>
    typeof value === 'function' ? CALLBACK : value,
  )
  // The key carries every value of `notices` the kept list shows.
  return useMemo(() => notices.map((notice) => owned(notice, committed)), [key])
}

const NONE: ReadonlyMap<string, ComposerError> = new Map()

/** What a single action does and to what; a kept notice never runs another offer. */
function actionIdentity(action: NonNullable<ComposerError['action']>): string {
  return action.key ?? action.label
}

/** The callbacks below keep only ids, never the notice or option they were made from. */
function owned(notice: ComposerError, committed: Committed): ComposerError {
  const id = notice.id
  const current = () => committed.current.get(id)
  const { action, choices, usageReset, report, dismiss } = notice
  const actionKey = action && actionIdentity(action)
  return {
    ...notice,
    ...(action
      ? {
          action: {
            ...(action.key === undefined ? {} : { key: action.key }),
            label: action.label,
            run: () => {
              const now = current()?.action
              if (now && actionIdentity(now) === actionKey) now.run()
            },
          },
        }
      : {}),
    ...(choices
      ? {
          choices: {
            label: choices.label,
            options: choices.options.map((option) => {
              const optionId = option.id
              return {
                ...option,
                run: () =>
                  current()
                    ?.choices?.options.find((choice) => choice.id === optionId)
                    ?.run(),
              }
            }),
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
