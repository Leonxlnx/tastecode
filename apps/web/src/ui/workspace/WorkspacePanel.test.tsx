// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetInstalls } from '../../provider-install.js'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

const hapticMocks = vi.hoisted(() => ({
  perform: vi.fn(),
  prepare: vi.fn(),
}))
const performHaptic = hapticMocks.perform
const prepareHaptics = hapticMocks.prepare

vi.mock('../../haptics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../haptics.js')>()),
  appHapticsEnabled: () => true,
  performAppHaptic: hapticMocks.perform,
  prepareAppHaptics: hapticMocks.prepare,
}))

vi.mock('./WorkspaceTerminal.js', () => ({
  WorkspaceTerminal: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Exit terminal
    </button>
  ),
}))

vi.mock('../InstallTerminal.js', () => ({
  InstallTerminal: ({
    installKey,
    ariaLabel,
    profile,
  }: {
    installKey: string
    ariaLabel?: string | undefined
    profile?: 'app' | 'workspace' | undefined
  }) => (
    <div
      data-testid="provider-login-terminal"
      data-install-key={installKey}
      data-profile={profile}
      aria-label={ariaLabel}
    />
  ),
}))

const idleTransport = new TestTransport()

afterEach(() => {
  cleanup()
  resetInstalls()
  performHaptic.mockClear()
  prepareHaptics.mockClear()
})

describe('WorkspacePanel', () => {
  const defaults = () => ({
    open: true,
    expanded: false,
    width: 400,
    transport: idleTransport,
    theme: 'dark' as const,
    sideChatParentStatus: 'idle' as const,
    sideChatStartOptions: { approval: 'ask' as const },
    nativeSurfacesVisible: true,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onWidthChange: vi.fn(),
  })

  it.each(['right', 'bottom'] as const)(
    'offers tool tabs without restoring expansion in the %s panel',
    async (placement) => {
      const props = defaults()
      const { container, rerender } = render(<WorkspacePanel {...props} placement={placement} />)
      expect(container.querySelector('.workspace-panel__chrome')).toBeNull()
      expect(screen.getByRole('tablist')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Add workspace tab' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Expand/ })).toBeNull()
      for (const name of ['Review', 'Terminal', 'Browser', 'Files', 'Temporary chat']) {
        expect(screen.getByRole('button', { name })).toBeTruthy()
      }
      fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
      await screen.findByRole('button', { name: 'Exit terminal' })
      expect(screen.getAllByRole('tab').length).toBeGreaterThan(0)
      fireEvent.click(
        screen.getByRole('button', {
          name: `Close ${placement === 'bottom' ? 'bottom' : 'right'} panel`,
        }),
      )
      expect(props.onClose).toHaveBeenCalledOnce()
      rerender(<WorkspacePanel {...props} placement={placement} open={false} />)
      rerender(<WorkspacePanel {...props} placement={placement} />)
      expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Exit terminal' })).toBeNull()
    },
  )

  it('keeps the bottom and right tool selection separate', async () => {
    const props = defaults()
    render(
      <>
        <WorkspacePanel {...props} placement="bottom" />
        <WorkspacePanel {...props} />
      </>,
    )
    const bottom = within(screen.getByRole('complementary', { name: 'Bottom workspace tools' }))
    const right = within(screen.getByRole('complementary', { name: 'Workspace tools' }))
    fireEvent.click(bottom.getByRole('button', { name: 'Terminal' }))
    await bottom.findByRole('button', { name: 'Exit terminal' })
    expect(right.getByRole('button', { name: 'Terminal' })).toBeTruthy()
    fireEvent.click(right.getByRole('button', { name: 'Terminal' }))
    await right.findByRole('button', { name: 'Exit terminal' })
    fireEvent.click(bottom.getByRole('button', { name: 'Close bottom panel' }))
    expect(right.getByRole('button', { name: 'Exit terminal' })).toBeTruthy()
  })

  it.each(['right', 'bottom'] as const)('still resizes the %s panel with its edge', (placement) => {
    const props = defaults()
    const { container } = render(<WorkspacePanel {...props} placement={placement} />)
    const bottom = placement === 'bottom'
    container.className = bottom ? 'bottom-terminal' : 'workspace-layout'
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1000 })
    const handle = screen.getByRole('separator')
    Object.defineProperty(handle, 'setPointerCapture', { configurable: true, value: vi.fn() })
    expect(handle.getAttribute('aria-orientation')).toBe(bottom ? 'horizontal' : 'vertical')
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 500, pointerId: 9 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 400, pointerId: 9 })
    fireEvent.blur(window)
    expect(props.onWidthChange).toHaveBeenCalledWith(500)
    expect(container.style.getPropertyValue(bottom ? 'height' : '--workspace-panel-w')).toBe(
      '500px',
    )
  })

  it('lets the right panel narrow to 300px and stops it there', () => {
    const props = defaults()
    const { container } = render(<WorkspacePanel {...props} />)
    container.className = 'workspace-layout'
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1000 })
    const handle = screen.getByRole('separator')
    Object.defineProperty(handle, 'setPointerCapture', { configurable: true, value: vi.fn() })
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 500, pointerId: 9 })
    fireEvent.pointerMove(window, { clientX: 900, clientY: 500, pointerId: 9 })
    fireEvent.blur(window)
    expect(props.onWidthChange).toHaveBeenCalledWith(300)
    expect(container.style.getPropertyValue('--workspace-panel-w')).toBe('300px')
  })

  it('keeps a shell when hidden with the panel toggle, and closes it on shell exit', async () => {
    const props = defaults()
    const view = render(<WorkspacePanel {...props} terminalToggleRequest={1} />)
    await screen.findByRole('button', { name: 'Exit terminal' })
    view.rerender(<WorkspacePanel {...props} terminalToggleRequest={2} />)
    expect(props.onClose).toHaveBeenCalledOnce()
    view.rerender(<WorkspacePanel {...props} open={false} terminalToggleRequest={2} />)
    view.rerender(<WorkspacePanel {...props} open={false} terminalToggleRequest={3} />)
    view.rerender(<WorkspacePanel {...props} terminalToggleRequest={3} />)
    expect(screen.getByRole('button', { name: 'Exit terminal' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Exit terminal' }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy()
  })

  it('closes the current provider login through its owner callback', async () => {
    const props = defaults()
    const onProviderLoginClose = vi.fn()
    render(
      <WorkspacePanel
        {...props}
        onProviderLoginClose={onProviderLoginClose}
        providerLogin={{ id: 4, title: 'Codex login', installKey: 'codex', canCancelSignIn: false }}
      />,
    )
    await screen.findByTestId('provider-login-terminal')
    fireEvent.click(screen.getByRole('button', { name: 'Close right panel' }))
    expect(onProviderLoginClose).toHaveBeenCalledWith(4)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('closes a provider login even when another tool is active', async () => {
    const props = defaults()
    const onProviderLoginClose = vi.fn()
    render(
      <WorkspacePanel
        {...props}
        onProviderLoginClose={onProviderLoginClose}
        providerLogin={{ id: 4, title: 'Codex login', installKey: 'codex', canCancelSignIn: false }}
      />,
    )
    await screen.findByTestId('provider-login-terminal')
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace tab' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }))
    await screen.findByRole('button', { name: 'Exit terminal' })
    fireEvent.click(screen.getByRole('button', { name: 'Close right panel' }))
    expect(onProviderLoginClose).toHaveBeenCalledWith(4)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('keeps earlier tool tabs mounted when another tool is requested', async () => {
    const props = defaults()
    const view = render(
      <WorkspacePanel {...props} externalToolRequest={{ request: 1, kind: 'terminal' }} />,
    )
    await screen.findByRole('button', { name: 'Exit terminal' })
    view.rerender(
      <WorkspacePanel {...props} externalToolRequest={{ request: 2, kind: 'browser' }} />,
    )
    await screen.findByRole('textbox', { name: 'Browser address' })
    expect(screen.getByRole('button', { name: 'Exit terminal', hidden: true })).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('reorders tab labels without moving the mounted surfaces', async () => {
    const props = defaults()
    const preview = (requestId: string) => ({ requestId, url: 'http://127.0.0.1:5173/' })
    const view = render(<WorkspacePanel {...props} designPreviewRequest={preview('a')} />)
    await screen.findByRole('textbox', { name: 'Browser address' })
    const terminal = { request: 1, kind: 'terminal' as const }
    view.rerender(
      <WorkspacePanel
        {...props}
        designPreviewRequest={preview('a')}
        externalToolRequest={terminal}
      />,
    )
    await screen.findByRole('button', { name: 'Exit terminal' })
    const body = view.container.querySelector('.workspace-panel__body')!
    const surfaces = Array.from(body.children)
    const observer = new MutationObserver(() => undefined)
    observer.observe(body, { childList: true })
    const tabTitles = () => screen.getAllByRole('tab').map((tab) => tab.textContent)

    view.rerender(
      <WorkspacePanel
        {...props}
        designPreviewRequest={preview('b')}
        externalToolRequest={terminal}
      />,
    )
    expect(tabTitles()).toEqual(['Terminal 1', 'New tab'])
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Browser: New tab' }), {
      key: 'ArrowLeft',
      altKey: true,
    })
    expect(tabTitles()).toEqual(['New tab', 'Terminal 1'])
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal 1' }), {
      key: 'ArrowLeft',
      altKey: true,
    })
    expect(tabTitles()).toEqual(['Terminal 1', 'New tab'])

    const removed = observer.takeRecords().flatMap((record) => Array.from(record.removedNodes))
    observer.disconnect()
    expect(removed).toEqual([])
    expect(Array.from(body.children)).toEqual(surfaces)
  })
})
