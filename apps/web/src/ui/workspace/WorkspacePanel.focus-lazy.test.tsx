// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

// Holds the Browser module back, like its first lazy load right after launch.
const browserModule = vi.hoisted(() => {
  let release!: () => void
  const loaded = new Promise<void>((resolve) => {
    release = resolve
  })
  return { loaded, release }
})
vi.mock('./WorkspaceBrowser.js', async (importOriginal) => {
  await browserModule.loaded
  return importOriginal()
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

it('keeps a URL typed while the Browser module loads out of the chat composer', async () => {
  const composer = document.createElement('textarea')
  composer.setAttribute('aria-label', 'Message')
  document.body.append(composer)
  composer.focus()
  const props = {
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
  }
  const view = render(<WorkspacePanel {...props} />)
  view.rerender(<WorkspacePanel {...props} externalToolRequest={{ request: 1, kind: 'browser' }} />)

  // The surface is still loading: focus waits on the new tab, not in the composer.
  expect(screen.queryByRole('textbox', { name: 'Browser address' })).toBeNull()
  const tab = screen.getByRole('tab', { selected: true })
  expect(document.activeElement).toBe(tab)

  await act(async () => browserModule.release())
  const address = await screen.findByRole(
    'textbox',
    { name: 'Browser address' },
    { timeout: 5_000 },
  )
  expect(document.activeElement).toBe(address)
}, 15_000)
