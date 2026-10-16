// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from './CopyButton.js'

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async (_text: string): Promise<void> => undefined),
}))

vi.mock('../bridge.js', () => ({ writeClipboardText }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  writeClipboardText.mockReset()
})

function activeLayer(button: HTMLElement): number {
  return [...button.querySelectorAll('.icon-morph__layer')].findIndex((layer) =>
    layer.hasAttribute('data-active'),
  )
}

/** Clicks and lets the clipboard promise settle. */
async function press(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button)
  })
}

describe('CopyButton', () => {
  it('copies through the app clipboard and shows the check for 1600ms', async () => {
    render(<CopyButton text="exact text" label="Copy response" />)
    const button = screen.getByRole('button', { name: 'Copy response' })
    expect(button.getAttribute('title')).toBe('Copy')
    expect(activeLayer(button)).toBe(0)

    await press(button)

    expect(writeClipboardText).toHaveBeenCalledWith('exact text')
    expect(activeLayer(button)).toBe(1)
    act(() => vi.advanceTimersByTime(1599))
    expect(activeLayer(button)).toBe(1)
    act(() => vi.advanceTimersByTime(1))
    expect(activeLayer(button)).toBe(0)
  })

  it('says a failed write failed and offers a retry', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    render(<CopyButton text="exact text" label="Copy prompt" />)
    const button = screen.getByRole('button', { name: 'Copy prompt' })

    await press(button)

    expect(activeLayer(button)).toBe(2)
    expect(button.getAttribute('title')).toBe('Copy failed — click to retry')
    expect(screen.getByRole('alert').textContent).toBe('Copy failed')
    expect(button.closest('.copy-action')?.classList.contains('is-failed')).toBe(true)

    await press(button)

    expect(writeClipboardText).toHaveBeenCalledTimes(2)
    expect(activeLayer(button)).toBe(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button.getAttribute('title')).toBe('Copy')
  })

  it('clears its reset timer when it unmounts', async () => {
    const view = render(<CopyButton text="exact text" label="Copy response" />)
    await press(screen.getByRole('button', { name: 'Copy response' }))
    expect(vi.getTimerCount()).toBe(1)

    view.unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})
