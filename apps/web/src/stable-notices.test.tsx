// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { startTransition, Suspense, use } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStableNotices } from './stable-notices.js'
import type { ComposerError } from './ui/ComposerErrors.js'

afterEach(cleanup)

const notice = (id: string, run: () => void, label = 'Retry'): ComposerError => ({
  id,
  message: `Notice ${id}`,
  action: { label, run },
})

function Notices(props: { notices: ComposerError[]; suspend?: Promise<never> | undefined }) {
  const shown = useStableNotices(props.notices)
  if (props.suspend) use(props.suspend)
  return (
    <>
      {shown.map((item) => (
        <div key={item.id}>
          {item.action ? <button onClick={item.action.run}>{item.action.label}</button> : null}
          {item.choices?.options.map((option) => (
            <button key={option.id} onClick={option.run}>
              {option.label}
            </button>
          ))}
        </div>
      ))}
    </>
  )
}

describe('useStableNotices', () => {
  it('keeps one list while the notices show the same, whatever the callbacks are', () => {
    const view = renderHook((notices: ComposerError[]) => useStableNotices(notices), {
      initialProps: [notice('a', () => {})],
    })
    const first = view.result.current
    view.rerender([notice('a', () => {})])
    expect(view.result.current).toBe(first)

    view.rerender([{ ...notice('a', () => {}), message: 'Failed again' }])
    expect(view.result.current).not.toBe(first)
    expect(view.result.current[0]?.message).toBe('Failed again')

    view.rerender([])
    const empty = view.result.current
    view.rerender([])
    expect(view.result.current).toBe(empty)
  })

  it('runs the latest committed callback of the same notice, with its return value', () => {
    const older = vi.fn()
    const newer = vi.fn()
    const scheduled = Promise.resolve()
    const schedule = vi.fn(() => scheduled)
    const view = renderHook(
      (run: () => void) =>
        useStableNotices([
          {
            ...notice('limit', run),
            usageReset: { source: 'Codex', scheduled: false, schedule, cancel: vi.fn() },
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
    expect(kept[0]!.usageReset!.schedule()).toBe(scheduled)
    expect(schedule).toHaveBeenCalledOnce()
  })

  it('keeps a retained handler on its own notice when others come, go or reorder', () => {
    const a = vi.fn()
    const b = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const withChoices = (options: Array<[string, () => void]>): ComposerError => ({
      id: 'elsewhere',
      message: 'Continue elsewhere',
      choices: { label: 'Continue', options: options.map(([id, run]) => ({ id, label: id, run })) },
    })
    const view = renderHook((notices: ComposerError[]) => useStableNotices(notices), {
      initialProps: [
        notice('a', a),
        withChoices([
          ['first', first],
          ['second', second],
        ]),
      ],
    })
    const retained = view.result.current

    // Another notice ahead of them, and the choices in another order.
    view.rerender([
      notice('b', b),
      notice('a', a),
      withChoices([
        ['second', second],
        ['first', first],
      ]),
    ])
    retained[0]!.action!.run()
    retained[1]!.choices!.options[0]!.run()
    expect(a).toHaveBeenCalledOnce()
    expect(b).not.toHaveBeenCalled()
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()

    // Once a notice is gone its handler does nothing.
    view.rerender([notice('b', b)])
    retained[0]!.action!.run()
    expect(a).toHaveBeenCalledOnce()
    expect(b).not.toHaveBeenCalled()
  })

  it('answers a kept scheduling handler of a notice that went away with a settled promise', async () => {
    const schedule = vi.fn(() => Promise.resolve())
    const view = renderHook((notices: ComposerError[]) => useStableNotices(notices), {
      initialProps: [
        {
          id: 'reset',
          message: 'Limit reached',
          usageReset: { source: 'Codex', scheduled: false, schedule, cancel: vi.fn() },
        },
      ] as ComposerError[],
    })
    const kept = view.result.current
    view.rerender([])
    await expect(kept[0]!.usageReset!.schedule()).resolves.toBeUndefined()
    expect(schedule).not.toHaveBeenCalled()
  })

  it('never runs the replacement when the only offer on a failure changes its target', () => {
    const toClaude = vi.fn()
    const toGrok = vi.fn()
    const offer = (key: string, label: string, run: () => void): ComposerError => ({
      id: 'chat:a:limit',
      message: "You've hit your usage limit.",
      action: { key, label, run },
    })
    const view = renderHook((notices: ComposerError[]) => useStableNotices(notices), {
      initialProps: [offer('switch:claude-code:opus', 'Switch to Claude Code', toClaude)],
    })
    const saved = view.result.current[0]!.action!

    // Same failure, another destination (the catalog changed).
    view.rerender([offer('switch:grok:grok-5', 'Switch to Grok', toGrok)])
    saved.run()
    expect(toGrok).not.toHaveBeenCalled()
    expect(toClaude).not.toHaveBeenCalled()

    // A same-key callback from a newer render still runs.
    view.rerender([offer('switch:claude-code:opus', 'Switch to Claude Code', toClaude)])
    saved.run()
    expect(toClaude).toHaveBeenCalledOnce()
  })

  it("keeps chat A's visible button on A while a render for chat B has not committed", async () => {
    const forA = vi.fn()
    const forB = vi.fn()
    const view = render(
      <Suspense fallback="Loading">
        <Notices notices={[notice('chat:a:limit', forA, 'Switch')]} />
      </Suspense>,
    )
    const button = screen.getByRole('button', { name: 'Switch' })

    // B's render suspends inside a transition, so A's list stays on screen.
    act(() => {
      startTransition(() => {
        view.rerender(
          <Suspense fallback="Loading">
            <Notices
              notices={[notice('chat:b:limit', forB, 'Switch')]}
              suspend={new Promise<never>(() => {})}
            />
          </Suspense>,
        )
      })
    })
    expect(screen.getByRole('button', { name: 'Switch' })).toBe(button)
    fireEvent.click(button)
    expect(forA).toHaveBeenCalledOnce()
    expect(forB).not.toHaveBeenCalled()
  })
})
