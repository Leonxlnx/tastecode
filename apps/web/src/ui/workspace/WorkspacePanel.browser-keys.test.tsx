// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

// Each fake Browser surface hands the test its Ctrl+W callback, the way the
// real one calls it for the key in its toolbar or inside its page.
const browsers = vi.hoisted(() => ({
  close: new Map<string, () => void>(),
  callbacks: new Set<unknown>(),
}))

vi.mock('./WorkspaceBrowser.js', () => ({
  WorkspaceBrowser: (props: { tabId?: string; onClose?: (tabId: string) => void }) => {
    browsers.callbacks.add(props.onClose)
    if (props.tabId && props.onClose) {
      const close = props.onClose
      const id = props.tabId
      browsers.close.set(id, () => close(id))
    }
    return <input aria-label="Browser address" />
  },
}))

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  browsers.close.clear()
  browsers.callbacks.clear()
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

it('closes the Browser tab Ctrl+W came from and focuses the tab shown next', async () => {
  const base = props()
  const view = render(
    <WorkspacePanel {...base} externalToolRequest={{ request: 1, kind: 'browser' }} />,
  )
  await vi.waitFor(() => expect(browsers.close.size).toBe(1))
  view.rerender(<WorkspacePanel {...base} externalToolRequest={{ request: 2, kind: 'browser' }} />)
  await vi.waitFor(() => expect(browsers.close.size).toBe(2))
  const [first, second] = [...browsers.close.keys()]
  screen.getAllByRole('textbox', { name: 'Browser address', hidden: true }).at(-1)!.focus()

  act(() => browsers.close.get(second!)!())
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(document.activeElement).toBe(screen.getByRole('tab'))
  expect(base.onClose).not.toHaveBeenCalled()
  // One stable callback for every surface keeps memoized Browser surfaces put.
  expect(browsers.callbacks.size).toBe(1)

  const toggle = document.createElement('button')
  toggle.className = 'panel-toggles__workspace'
  document.body.append(toggle)
  act(() => browsers.close.get(first!)!())
  expect(screen.queryAllByRole('tab')).toEqual([])
  expect(base.onClose).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(toggle)
})
