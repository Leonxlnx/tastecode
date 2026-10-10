// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RendererErrorBoundary } from './RendererErrorBoundary.js'
import { reportRendererError, writeClipboardText } from './bridge.js'

vi.mock('./bridge.js', () => ({
  isDesktop: true,
  reportRendererError: vi.fn(),
  writeClipboardText: vi.fn(async () => {}),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const failure = new Error('private-fixture /Users/private/project token=private-fixture')
function Broken(): never {
  throw failure
}

describe('renderer recovery', () => {
  it('renders healthy children normally', () => {
    render(
      <RendererErrorBoundary>
        <p>Ready</p>
      </RendererErrorBoundary>,
    )
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each(['light', 'dark'])('recovers from a render exception in %s mode', async (theme) => {
    document.documentElement.dataset.theme = theme
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    render(
      <RendererErrorBoundary reload={reload}>
        <Broken />
      </RendererErrorBoundary>,
    )
    expect(screen.getByRole('heading').textContent).toContain('couldn’t display')
    const button = screen.getByRole('button', { name: 'Reload window' })
    expect(document.activeElement).toBe(button)
    expect(reportRendererError).toHaveBeenCalledWith(failure)
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Diagnostics copied.'))
    expect(screen.getByRole('status').dataset['state']).toBe('copied')
    const copied = vi.mocked(writeClipboardText).mock.calls[0]?.[0]
    expect(copied).toContain('Failure: application render exception')
    expect(copied).not.toContain('private')
    expect(copied).not.toContain('/Users')
    fireEvent.click(button)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps recovery available if diagnostics and clipboard fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(reportRendererError).mockImplementationOnce(() => {
      throw new Error('bridge failed')
    })
    vi.mocked(writeClipboardText).mockRejectedValueOnce(new Error('clipboard unavailable'))
    render(
      <RendererErrorBoundary>
        <Broken />
      </RendererErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Could not copy'))
    expect(screen.getByRole('status').dataset['state']).toBe('failed')
    expect(screen.getByRole('button', { name: 'Reload window' })).toBeTruthy()
  })

  it('orders actions so keyboard focus starts on reload and reaches copy next', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <RendererErrorBoundary>
        <Broken />
      </RendererErrorBoundary>,
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Copy diagnostics',
      'Reload window',
    ])
    expect(document.activeElement).toBe(buttons[1])
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
