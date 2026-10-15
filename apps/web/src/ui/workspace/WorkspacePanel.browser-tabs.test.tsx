// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import type { BrowserPageInfo } from './browser-page.js'
import { WorkspacePanel } from './WorkspacePanel.js'

// Each fake Browser surface hands its report function to the test, the way
// the real guest reports did-navigate and page-title-updated.
const browsers = vi.hoisted(() => ({
  reports: new Map<string, (page: BrowserPageInfo) => void>(),
  callbacks: new Set<unknown>(),
}))

vi.mock('./WorkspaceBrowser.js', () => ({
  WorkspaceBrowser: (props: {
    tabId?: string
    onPageInfo?: (tabId: string, page: BrowserPageInfo) => void
  }) => {
    browsers.callbacks.add(props.onPageInfo)
    if (props.tabId && props.onPageInfo) {
      const report = props.onPageInfo
      const id = props.tabId
      browsers.reports.set(id, (page) => report(id, page))
    }
    return <div data-testid="browser-surface" />
  },
}))

afterEach(() => {
  cleanup()
  browsers.reports.clear()
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

const tabs = () =>
  screen.getAllByRole('tab').map((tab) => ({
    text: tab.textContent,
    name: tab.getAttribute('aria-label'),
    tooltip: tab.getAttribute('title'),
  }))

it('labels each Browser tab by its page title or host instead of "Browser"', async () => {
  const base = props()
  const view = render(
    <WorkspacePanel {...base} externalToolRequest={{ request: 1, kind: 'browser' }} />,
  )
  await screen.findAllByTestId('browser-surface')
  view.rerender(<WorkspacePanel {...base} externalToolRequest={{ request: 2, kind: 'browser' }} />)
  await vi.waitFor(() => expect(browsers.reports.size).toBe(2))
  expect(tabs().map((tab) => tab.text)).toEqual(['New tab', 'New tab'])

  const [first, second] = [...browsers.reports.values()]
  act(() => {
    first!({ url: 'https://northwind.test/coffees', title: 'Coffees · Northwind Roasters' })
    second!({ url: 'http://127.0.0.1:5173/checkout', title: '' })
  })
  expect(tabs()).toEqual([
    {
      text: 'Coffees · Northwind Roasters',
      name: 'Browser: Coffees · Northwind Roasters',
      tooltip: 'https://northwind.test/coffees',
    },
    {
      text: '127.0.0.1:5173',
      name: 'Browser: 127.0.0.1:5173',
      tooltip: 'http://127.0.0.1:5173/checkout',
    },
  ])
  expect(screen.getByRole('button', { name: 'Close Browser: 127.0.0.1:5173' })).toBeTruthy()
  // Every surface gets the one stable owner callback, so memoized surfaces stay put.
  expect(browsers.callbacks.size).toBe(1)
  // The + menu still opens more tabs.
  expect(screen.getByRole('button', { name: 'Add workspace tab' })).toBeTruthy()
})

it('forgets a closed tab page so a later tab starts as New tab', async () => {
  const base = props()
  const view = render(
    <WorkspacePanel {...base} externalToolRequest={{ request: 1, kind: 'browser' }} />,
  )
  await screen.findByTestId('browser-surface')
  view.rerender(<WorkspacePanel {...base} externalToolRequest={{ request: 2, kind: 'terminal' }} />)
  const [report] = [...browsers.reports.values()]
  act(() => report!({ url: 'https://example.com/', title: 'Example Domain' }))
  expect(screen.getByRole('tab', { name: 'Browser: Example Domain' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Close Browser: Example Domain' }))
  await vi.waitFor(() =>
    expect(screen.queryByRole('tab', { name: 'Browser: Example Domain' })).toBeNull(),
  )
})
