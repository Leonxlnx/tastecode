// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useStableEntries } from './stable-entries.js'

type Entry = {
  id: string
  message: string
  action?: { label: string; run: () => void }
  usageReset?: { scheduled: boolean; schedule: () => Promise<void> }
}

describe('useStableEntries', () => {
  it('keeps one list while the data is the same, whatever the callbacks are', () => {
    const view = renderHook((entries: Entry[]) => useStableEntries(entries), {
      initialProps: [{ id: 'a', message: 'Failed', action: { label: 'Retry', run: () => {} } }],
    })
    const first = view.result.current
    view.rerender([{ id: 'a', message: 'Failed', action: { label: 'Retry', run: () => {} } }])
    expect(view.result.current).toBe(first)

    view.rerender([{ id: 'a', message: 'Failed again', action: { label: 'Retry', run: () => {} } }])
    expect(view.result.current).not.toBe(first)
    expect(view.result.current[0]?.message).toBe('Failed again')

    const empty = (view.rerender([]), view.result.current)
    view.rerender([])
    expect(view.result.current).toBe(empty)
  })

  it('runs the newest render’s callback from a kept list, with its arguments and result', async () => {
    const older = vi.fn()
    const newer = vi.fn()
    const schedule = vi.fn(() => Promise.resolve())
    const view = renderHook(
      (run: () => void) =>
        useStableEntries<Entry>([
          {
            id: 'a',
            message: 'Limit reached',
            action: { label: 'Retry', run },
            usageReset: { scheduled: false, schedule },
          },
        ]),
      { initialProps: older },
    )
    const kept = view.result.current
    view.rerender(newer)
    expect(view.result.current).toBe(kept)

    kept[0]!.action!.run()
    expect(newer).toHaveBeenCalledOnce()
    expect(older).not.toHaveBeenCalled()
    await expect(kept[0]!.usageReset!.schedule()).resolves.toBeUndefined()
    expect(schedule).toHaveBeenCalledOnce()
  })

  it('treats a callback that comes or goes as a change', () => {
    const view = renderHook(
      (dismiss: (() => void) | undefined) =>
        useStableEntries([{ id: 'a', message: 'Failed', ...(dismiss ? { dismiss } : {}) }]),
      { initialProps: undefined as (() => void) | undefined },
    )
    const first = view.result.current
    view.rerender(() => {})
    expect(view.result.current).not.toBe(first)
    expect(typeof (view.result.current[0] as { dismiss?: unknown }).dismiss).toBe('function')
  })
})
