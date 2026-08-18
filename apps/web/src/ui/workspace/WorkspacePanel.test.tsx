// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginLogin, resetInstalls } from '../../provider-install.js'
import { requiredElement, requiredInstance } from '../../test-dom.js'
import { TestTransport } from '../../test-transport.js'
import {
  WorkspacePanel,
  type WorkspacePanelHaptics,
  type WorkspacePanelProviderTerminal,
  type WorkspacePanelTerminal,
} from './WorkspacePanel.js'

const performHaptic = vi.fn<WorkspacePanelHaptics['perform']>()
const prepareHaptics = vi.fn<WorkspacePanelHaptics['prepare']>()
const haptics = {
  enabled: () => true,
  perform: performHaptic,
  prepare: prepareHaptics,
} satisfies WorkspacePanelHaptics

const TestTerminal = (({ onClose }) => (
  <button type="button" onClick={onClose}>
    Exit terminal
  </button>
)) satisfies WorkspacePanelTerminal

const TestProviderTerminal = (({ installKey, ariaLabel, profile }) => (
  <div
    data-testid="provider-login-terminal"
    data-install-key={installKey}
    data-profile={profile}
    aria-label={ariaLabel}
  />
)) satisfies WorkspacePanelProviderTerminal

const idleTransport = new TestTransport()

class TestMediaQueryList extends EventTarget implements MediaQueryList {
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null = null
  constructor(
    readonly matches: boolean,
    readonly media: string,
  ) {
    super()
  }
  addListener(): void {}
  removeListener(): void {}
}

afterEach(() => {
  cleanup()
  resetInstalls()
  performHaptic.mockClear()
  prepareHaptics.mockClear()
})

describe('WorkspacePanel', () => {
  it('finishes closing immediately when reduced motion removes the transition', async () => {
    const onClosed = vi.fn()
    const matchMedia = vi
      .spyOn(window, 'matchMedia')
      .mockImplementation(
        (query) => new TestMediaQueryList(query === '(prefers-reduced-motion: reduce)', query),
      )

    render(
      <WorkspacePanel
        open={false}
        expanded={false}
        width={400}
        transport={idleTransport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onClosed={onClosed}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    )

    await waitFor(() => expect(onClosed).toHaveBeenCalledOnce())
    matchMedia.mockRestore()
  })

  it('gives resize detents only while the panel is tracking', () => {
    const onWidthChange = vi.fn()
    const { container } = render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onExpandedChange={vi.fn()}
        onWidthChange={onWidthChange}
        haptics={haptics}
      />,
    )

    const handle = screen.getByRole('separator', { name: 'Resize workspace tools' })
    container.className = 'workspace-layout'
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 900 })
    Object.defineProperty(handle, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })

    fireEvent.pointerEnter(handle)
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 7 })
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 7 })

    expect(onWidthChange).toHaveBeenCalledWith(480)
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 7 })
    expect(onWidthChange).toHaveBeenLastCalledWith(540)
    expect(prepareHaptics).toHaveBeenCalled()
    expect(performHaptic).toHaveBeenCalledWith('alignment')

    fireEvent.blur(window)
    const widthCalls = onWidthChange.mock.calls.length
    fireEvent.pointerMove(window, { clientX: 380, pointerId: 7 })
    expect(onWidthChange).toHaveBeenCalledTimes(widthCalls)
  })

  it('closes the sidebar when its final tab closes', async () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
        projectPath="/workspace/project"
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={onClose}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        terminalComponent={TestTerminal}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
    rerender(
      <WorkspacePanel
        open={false}
        expanded={false}
        width={400}
        transport={idleTransport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={onClose}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        terminalComponent={TestTerminal}
      />,
    )
    fireEvent.transitionEnd(requiredElement(document, '.workspace-panel', HTMLElement), {
      propertyName: 'transform',
    })
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull()
  })

  it('keeps panel controls inside the workspace chrome', () => {
    const onExpandedChange = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onExpandedChange={onExpandedChange}
        onWidthChange={vi.fn()}
        terminalComponent={TestTerminal}
      />,
    )

    for (const title of ['Review', 'Terminal', 'Browser', 'Files', 'Temporary chat']) {
      expect(screen.getByRole('button', { name: title }).querySelector('svg')).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Expand workspace tools' }))
    expect(onExpandedChange).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('button', { name: 'Hide workspace tools' })).toBeNull()
  })

  it('opens a provider login in its own workspace terminal tab', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'providers.launch') return { terminalId: 'claude-login-terminal' }
      if (method === 'terminal.input') return {}
      throw new Error(`unexpected ${method}`)
    })
    await beginLogin(transport, { provider: 'claude-code' }, () => {})
    const onOpen = vi.fn()
    const onProviderLoginClose = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded
        width={400}
        transport={transport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={onOpen}
        onClose={vi.fn()}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        providerLogin={{
          id: 7,
          title: 'Claude Code login',
          installKey: 'login:claude-code',
        }}
        providerTerminalComponent={TestProviderTerminal}
        onProviderLoginClose={onProviderLoginClose}
      />,
    )

    expect(await screen.findByRole('tab', { name: 'Claude Code login' })).toBeTruthy()
    const terminal = screen.getByTestId('provider-login-terminal')
    expect(terminal.getAttribute('data-install-key')).toBe('login:claude-code')
    expect(terminal.getAttribute('data-profile')).toBe('workspace')
    expect(terminal.getAttribute('aria-label')).toBe('Claude Code login terminal')
    expect(onOpen).toHaveBeenCalledOnce()

    const code = requiredInstance(screen.getByLabelText('Claude login code'), HTMLInputElement)
    expect(code.placeholder).toBe('Paste code here if prompted')
    expect(code.autocomplete).toBe('one-time-code')
    fireEvent.change(code, { target: { value: 'test-login-code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }))
    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'terminal.input',
        params: { terminalId: 'claude-login-terminal', data: 'test-login-code\r' },
      }),
    )
    expect(code.value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Close Claude Code login' }))
    expect(onProviderLoginClose).toHaveBeenCalledWith(7)
    expect(screen.queryByRole('tab', { name: 'Claude Code login' })).toBeNull()
  })

  it('routes a workspace shell exit through the terminal tab close path', async () => {
    const onClose = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={idleTransport}
        projectPath="/workspace/project"
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={vi.fn()}
        onClose={onClose}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        terminalComponent={TestTerminal}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Exit terminal' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy()
  })

  it.each(['Browser', 'Terminal', 'Files'] as const)(
    'opens independent %s tabs and closes one with the middle mouse button',
    async (tool) => {
      render(
        <WorkspacePanel
          open
          expanded={false}
          width={400}
          transport={idleTransport}
          theme="dark"
          sideChatParentStatus="idle"
          sideChatStartOptions={{ approval: 'ask' }}
          nativeSurfacesVisible
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onExpandedChange={vi.fn()}
          onWidthChange={vi.fn()}
          terminalComponent={TestTerminal}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: tool }))
      await waitFor(() => expect(screen.getAllByRole('tab', { name: tool })).toHaveLength(1))
      fireEvent.click(screen.getByRole('button', { name: 'Add workspace tab' }))
      fireEvent.click(screen.getByRole('menuitem', { name: tool }))
      await waitFor(() => expect(screen.getAllByRole('tab', { name: tool })).toHaveLength(2))

      fireEvent(
        screen.getAllByRole('tab', { name: tool })[0]!,
        new MouseEvent('auxclick', { bubbles: true, button: 1 }),
      )
      expect(screen.getAllByRole('tab', { name: tool })).toHaveLength(1)
    },
  )

  it('opens one reusable Browser tab for design preview captures', async () => {
    const transport = new TestTransport()
    const onOpen = vi.fn()
    render(
      <WorkspacePanel
        open
        expanded={false}
        width={400}
        transport={transport}
        theme="dark"
        sideChatParentStatus="idle"
        sideChatStartOptions={{ approval: 'ask' }}
        nativeSurfacesVisible
        onOpen={onOpen}
        onClose={vi.fn()}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
      />,
    )
    const request = (requestId: string) => ({
      requestId,
      url: 'http://127.0.0.1:4173/',
      viewports: [{ width: 1_280, height: 800 }],
    })
    act(() =>
      transport.emit('preview.captureRequested', request('00000000-0000-4000-8000-000000000001')),
    )
    await waitFor(() => expect(screen.getAllByRole('tab', { name: 'Browser' })).toHaveLength(1))

    act(() =>
      transport.emit('preview.captureRequested', request('00000000-0000-4000-8000-000000000002')),
    )
    expect(screen.getAllByRole('tab', { name: 'Browser' })).toHaveLength(1)
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
