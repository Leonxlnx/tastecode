// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useArchiveMotion } from './useArchiveMotion.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('waits for visible rows to exit and ignores repeat archive clicks', async () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const commit = vi.fn()
  function Harness() {
    const archive = useArchiveMotion()
    return (
      <>
        <div
          data-archive-session-id="a"
          ref={(node) => {
            if (node)
              node.animate = vi.fn(() => ({ finished, cancel: vi.fn() }) as unknown as Animation)
          }}
        />
        <button onClick={() => archive(['a'], commit)}>Archive</button>
      </>
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByText('Archive'))
  fireEvent.click(screen.getByText('Archive'))
  expect(commit).not.toHaveBeenCalled()
  await act(async () => finish())
  expect(commit).toHaveBeenCalledExactlyOnceWith(['a'])
})
