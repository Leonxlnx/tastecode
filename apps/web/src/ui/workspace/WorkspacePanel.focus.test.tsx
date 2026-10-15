// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

vi.mock('./WorkspaceTerminal.js', () => ({
  WorkspaceTerminal: () => <div data-testid="terminal-pane" />,
}))

// The surfaces load lazily; give a loaded machine time to import them.
const LAZY = { timeout: 5_000 }
const SLOW = { timeout: 15_000 }

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
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

/** Stands in for the chat composer, which has focus when the user presses Ctrl+T. */
function focusComposer(): HTMLTextAreaElement {
  const composer = document.createElement('textarea')
  composer.setAttribute('aria-label', 'Message')
  document.body.append(composer)
  composer.focus()
  return composer
}

it('focuses the address of a Browser tab the user opens from the + menu', SLOW, async () => {
  render(<WorkspacePanel {...props()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
  await screen.findByTestId('terminal-pane', undefined, LAZY)
  fireEvent.click(screen.getByRole('button', { name: 'Add workspace tab' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Browser/ }))

  const address = await screen.findByRole('textbox', { name: 'Browser address' }, LAZY)
  expect(document.activeElement).toBe(address)
})

it(
  'moves focus from the composer to the address when Ctrl+T opens a Browser tab',
  SLOW,
  async () => {
    const composer = focusComposer()
    const base = props()
    const view = render(<WorkspacePanel {...base} />)
    expect(document.activeElement).toBe(composer)
    view.rerender(
      <WorkspacePanel {...base} externalToolRequest={{ request: 1, kind: 'browser' }} />,
    )

    const address = await screen.findByRole('textbox', { name: 'Browser address' }, LAZY)
    expect(document.activeElement).toBe(address)

    // A later render of the same tab does not take focus back from the composer.
    composer.focus()
    view.rerender(
      <WorkspacePanel
        {...base}
        externalToolRequest={{ request: 1, kind: 'browser' }}
        theme="light"
      />,
    )
    expect(document.activeElement).toBe(composer)
  },
)

it('leaves focus in the composer when the agent opens a design preview', SLOW, async () => {
  const composer = focusComposer()
  render(
    <WorkspacePanel
      {...props()}
      designPreviewRequest={{ requestId: 'preview', url: 'http://127.0.0.1:5173/' }}
    />,
  )
  await screen.findByRole('textbox', { name: 'Browser address' }, LAZY)
  expect(document.activeElement).toBe(composer)
})
