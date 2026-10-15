// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import type { BrowserPageInfo } from './browser-page.js'
import { WorkspacePanel } from './WorkspacePanel.js'

// Mount counts prove a surface survives: a remount would count again.
const mounts = vi.hoisted(() => ({ terminal: 0, browser: 0 }))

vi.mock('./WorkspaceTerminal.js', async () => {
  const { useEffect } = await import('react')
  return {
    WorkspaceTerminal: ({ onClose }: { onClose: () => void }) => {
      useEffect(() => {
        mounts.terminal += 1
      }, [])
      return (
        <button type="button" onClick={onClose}>
          Exit terminal
        </button>
      )
    },
  }
})

vi.mock('./WorkspaceBrowser.js', async () => {
  const { useEffect } = await import('react')
  return {
    WorkspaceBrowser: (props: {
      tabId?: string
      onPageInfo?: (tabId: string, page: BrowserPageInfo) => void
    }) => {
      useEffect(() => {
        mounts.browser += 1
        props.onPageInfo?.(props.tabId!, { url: 'http://127.0.0.1:5173/', title: 'Shop' })
      }, [])
      return <div data-testid="browser-surface" />
    },
  }
})

vi.mock('../InstallTerminal.js', () => ({
  InstallTerminal: () => <div data-testid="provider-login-terminal" />,
}))

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  mounts.terminal = 0
  mounts.browser = 0
})

const props = () => ({
  open: true,
  expanded: false,
  width: 400,
  transport: new TestTransport(),
  theme: 'dark' as const,
  sideChatParentStatus: 'idle' as const,
  sideChatStartOptions: { approval: 'ask' as const },
  nativeSurfacesVisible: true,
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onWidthChange: vi.fn(),
})

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))

it('hides the right panel with its X and brings every tab back unchanged', async () => {
  const base = props()
  const view = render(
    <WorkspacePanel {...base} externalToolRequest={{ request: 1, kind: 'terminal' }} />,
  )
  await screen.findByRole('button', { name: 'Exit terminal' })
  view.rerender(<WorkspacePanel {...base} externalToolRequest={{ request: 2, kind: 'browser' }} />)
  await vi.waitFor(() => expect(tabNames()).toEqual(['Terminal 1', 'Browser: Shop']))
  const terminal = screen.getByRole('button', { name: 'Exit terminal', hidden: true })

  fireEvent.click(screen.getByRole('button', { name: 'Hide right panel' }))
  expect(base.onClose).toHaveBeenCalledOnce()

  view.rerender(
    <WorkspacePanel {...base} open={false} externalToolRequest={{ request: 2, kind: 'browser' }} />,
  )
  // Hidden, not closed: the surfaces stay mounted behind the inert panel.
  expect(screen.getByRole('complementary', { hidden: true }).hasAttribute('inert')).toBe(true)
  expect(screen.getByRole('button', { name: 'Exit terminal', hidden: true })).toBe(terminal)

  view.rerender(<WorkspacePanel {...base} externalToolRequest={{ request: 2, kind: 'browser' }} />)
  expect(tabNames()).toEqual(['Terminal 1', 'Browser: Shop'])
  expect(screen.getByRole('tab', { name: 'Browser: Shop' }).getAttribute('aria-selected')).toBe(
    'true',
  )
  expect(screen.getByRole('button', { name: 'Exit terminal', hidden: true })).toBe(terminal)
  expect(mounts).toEqual({ terminal: 1, browser: 1 })
})

it('still closes one tab with its own X, and hides the panel when the last one goes', async () => {
  const base = props()
  const view = render(
    <WorkspacePanel {...base} externalToolRequest={{ request: 1, kind: 'terminal' }} />,
  )
  await screen.findByRole('button', { name: 'Exit terminal' })
  view.rerender(<WorkspacePanel {...base} externalToolRequest={{ request: 2, kind: 'browser' }} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Close Browser: Shop' }))
  await vi.waitFor(() => expect(tabNames()).toEqual(['Terminal 1']))
  expect(base.onClose).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }))
  await vi.waitFor(() => expect(screen.queryAllByRole('tab')).toEqual([]))
  expect(base.onClose).toHaveBeenCalledOnce()
  // Opened again, the panel offers the tools instead of a dead tab.
  expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy()
})

it('closes a provider login through its owner when hidden, and keeps the other tabs', async () => {
  const base = props()
  const onProviderLoginClose = vi.fn()
  const login = { id: 4, title: 'Codex login', installKey: 'codex', canCancelSignIn: false }
  const view = render(
    <WorkspacePanel
      {...base}
      providerLogin={login}
      onProviderLoginClose={onProviderLoginClose}
      externalToolRequest={{ request: 1, kind: 'terminal' }}
    />,
  )
  await screen.findByRole('button', { name: 'Exit terminal', hidden: true })
  await screen.findByTestId('provider-login-terminal')

  fireEvent.click(screen.getByRole('button', { name: 'Hide right panel' }))
  expect(onProviderLoginClose).toHaveBeenCalledWith(4)
  expect(base.onClose).toHaveBeenCalledOnce()

  // The owner ends the login, as App does when it is told to close it.
  view.rerender(
    <WorkspacePanel
      {...base}
      onProviderLoginClose={onProviderLoginClose}
      externalToolRequest={{ request: 1, kind: 'terminal' }}
    />,
  )
  expect(tabNames()).toEqual(['Terminal 1'])
  expect(screen.queryByTestId('provider-login-terminal')).toBeNull()
})

it('hands focus to the panel toggle when the X hides the panel it was in', () => {
  const toggle = document.createElement('button')
  toggle.className = 'panel-toggles__workspace'
  document.body.append(toggle)
  render(<WorkspacePanel {...props()} />)

  const hide = screen.getByRole('button', { name: 'Hide right panel' })
  hide.focus()
  fireEvent.click(hide)
  expect(document.activeElement).toBe(toggle)
})

it('keeps the bottom panel X closing its tabs', async () => {
  const base = props()
  const view = render(
    <WorkspacePanel
      {...base}
      placement="bottom"
      externalToolRequest={{ request: 1, kind: 'terminal' }}
    />,
  )
  await screen.findByRole('button', { name: 'Exit terminal' })
  fireEvent.click(screen.getByRole('button', { name: 'Close bottom panel' }))
  expect(base.onClose).toHaveBeenCalledOnce()
  view.rerender(
    <WorkspacePanel
      {...base}
      placement="bottom"
      externalToolRequest={{ request: 1, kind: 'terminal' }}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Exit terminal' })).toBeNull()
})
