// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RendererErrorBoundary } from './RendererErrorBoundary.js'
import { crashAgents, launchCrashAgent, reportRendererError, writeClipboardText } from './bridge.js'

vi.mock('./bridge.js', () => ({
  isDesktop: true,
  canLaunchCrashAgent: true,
  crashAgents: vi.fn(async () => [
    { id: 'claude-code', installed: true },
    { id: 'codex', installed: true },
    { id: 'grok', installed: false },
  ]),
  launchCrashAgent: vi.fn(async () => {}),
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
    expect(screen.getByRole('status').dataset['tone']).toBe('success')
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
    expect(screen.getByRole('status').dataset['tone']).toBe('error')
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
      'Ask an agent to fix itOpens Claude Code, Codex or Grok',
      'Copy diagnostics',
      'Reload window',
    ])
    expect(document.activeElement).toBe(buttons[2])
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('hands the crash to the chosen agent and comes back to the summary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <RendererErrorBoundary>
        <Broken />
      </RendererErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Ask an agent/ }))
    expect(screen.getByRole('heading').textContent).toBe('Which agent should look at this?')
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Grok/ }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    )
    expect(screen.getByRole('button', { name: /Grok/ }).textContent).toContain('Not installed')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Claude Code/ }))
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Opened Codex in your terminal.'),
    )
    expect(launchCrashAgent).toHaveBeenCalledWith('codex', failure, expect.any(String))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Ask an agent/ }))
  })

  it('stays on the picker with an error when the terminal cannot open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(launchCrashAgent).mockRejectedValueOnce(new Error('no terminal'))
    render(
      <RendererErrorBoundary>
        <Broken />
      </RendererErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Ask an agent/ }))
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Could not open Claude Code in a terminal.',
      ),
    )
    expect(screen.getByRole('status').dataset['tone']).toBe('error')
    fireEvent.keyDown(screen.getByRole('button', { name: /Claude Code/ }), { key: 'Escape' })
    expect(screen.getByRole('heading').textContent).toContain('couldn’t display')
  })

  it('moves focus off an agent that turns out to be missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(crashAgents).mockResolvedValueOnce([
      { id: 'claude-code', installed: false },
      { id: 'codex', installed: true },
      { id: 'grok', installed: true },
    ])
    render(
      <RendererErrorBoundary>
        <Broken />
      </RendererErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Ask an agent/ }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Codex/ })),
    )
  })
})
