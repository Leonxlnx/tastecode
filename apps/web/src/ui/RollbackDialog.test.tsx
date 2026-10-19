// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Checkpoint, RollbackDialog } from './RollbackDialog.js'

const checkpoints: Checkpoint[] = [
  { id: 1, seq: 1, label: 'Create three files plan-a.txt', createdAt: Date.UTC(2026, 9, 16, 0, 4) },
  {
    id: 2,
    seq: 2,
    label: 'Append a second line to notes.txt',
    createdAt: Date.UTC(2026, 9, 16, 0, 7),
  },
  {
    id: 3,
    seq: 3,
    label: 'Reply with the single word ok',
    createdAt: Date.UTC(2026, 9, 16, 0, 13),
  },
]
const [first, second, newest] = checkpoints as [Checkpoint, Checkpoint, Checkpoint]

function props(
  overrides: Partial<ComponentProps<typeof RollbackDialog>> = {},
): ComponentProps<typeof RollbackDialog> {
  return {
    checkpoints,
    inspection: undefined,
    loadingId: undefined,
    restoring: false,
    onInspect: vi.fn(),
    onRestore: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

const prompt = (checkpoint: Checkpoint) =>
  screen.getByRole<HTMLButtonElement>('button', { name: `Before “${checkpoint.label}”` })
const restore = () =>
  within(screen.getByRole('dialog', { name: 'Restore' })).getByRole<HTMLButtonElement>('button', {
    name: /^Restor/,
  })

afterEach(cleanup)

describe('RollbackDialog', () => {
  it('owns focus, traps app shortcuts, closes with Escape, and restores focus', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const onClose = vi.fn()
    const shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)

    const view = render(<RollbackDialog {...props({ onClose })} />)
    const panel = view.container.querySelector<HTMLElement>('.rollback')
    if (!panel) throw new Error('missing rollback panel')
    await waitFor(() => expect(document.activeElement).toBe(panel))

    fireEvent.keyDown(panel, { key: 'n', metaKey: true })
    expect(shortcut).not.toHaveBeenCalled()

    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()

    view.unmount()
    expect(document.activeElement).toBe(opener)
    window.removeEventListener('keydown', shortcut)
    opener.remove()
  })

  it('shows every prompt in chat order with its time in the tooltip', () => {
    render(<RollbackDialog {...props()} />)

    expect(
      within(screen.getByRole('list'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      'Create three files plan-a.txt',
      'Append a second line to notes.txt',
      'Reply with the single word ok',
    ])
    expect(prompt(second).title).toBe(new Date(second.createdAt).toLocaleString())
  })

  it('asks for a prompt and offers no restore while nothing is picked', () => {
    render(<RollbackDialog {...props()} />)

    expect(screen.getByRole('status').textContent).toBe('Pick a prompt to go back to')
    expect(restore().textContent).toBe('Restore')
    expect(restore().disabled).toBe(true)
    expect(
      checkpoints.map((checkpoint) => prompt(checkpoint).getAttribute('aria-pressed')),
    ).toEqual(['false', 'false', 'false'])
  })

  it('names the files that go back with the picked prompt', () => {
    const onRestore = vi.fn()
    render(
      <RollbackDialog
        {...props({
          inspection: { checkpoint: second, files: ['notes.txt', 'src/math.js', 'README.md'] },
          onRestore,
        })}
      />,
    )

    expect(screen.getByRole('status').textContent).toBe(
      'notes.txt, src/math.js and README.md go back too',
    )
    expect(
      checkpoints.map((checkpoint) => prompt(checkpoint).getAttribute('aria-pressed')),
    ).toEqual(['false', 'true', 'false'])
    fireEvent.click(restore())
    expect(onRestore).toHaveBeenCalledOnce()
  })

  it('says when files stay and shortens a long file list', () => {
    const view = render(
      <RollbackDialog {...props({ inspection: { checkpoint: newest, files: [] } })} />,
    )
    expect(screen.getByRole('status').textContent).toBe('Files stay as they are')

    view.rerender(
      <RollbackDialog
        {...props({
          inspection: { checkpoint: first, files: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'] },
        })}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('a.txt, b.txt and 3 more files go back too')
  })

  it('keeps the cut on a loading prompt and reports the load to assistive tech', () => {
    const view = render(<RollbackDialog {...props({ loadingId: second.id })} />)

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Loading files')
    expect(prompt(second).getAttribute('aria-pressed')).toBe('true')
    expect(prompt(first).disabled).toBe(false)
    expect(restore().disabled).toBe(true)

    view.rerender(
      <RollbackDialog {...props({ inspection: { checkpoint: second, files: ['notes.txt'] } })} />,
    )
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe('notes.txt go back too')
    expect(restore().disabled).toBe(false)
  })

  it('picks a prompt on click', () => {
    const onInspect = vi.fn()
    render(<RollbackDialog {...props({ onInspect })} />)

    fireEvent.click(prompt(first))
    expect(onInspect).toHaveBeenCalledWith(first)
  })

  it('moves the cut between prompts with the arrow keys', async () => {
    const onInspect = vi.fn()
    const view = render(
      <RollbackDialog {...props({ inspection: { checkpoint: second, files: [] }, onInspect })} />,
    )
    const panel = view.container.querySelector<HTMLElement>('.rollback')!
    await waitFor(() => expect(document.activeElement).toBe(panel))

    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    expect(onInspect).toHaveBeenLastCalledWith(newest)

    prompt(second).focus()
    fireEvent.keyDown(prompt(second), { key: 'ArrowUp' })
    expect(onInspect).toHaveBeenLastCalledWith(first)
    expect(document.activeElement).toBe(prompt(first))

    view.rerender(
      <RollbackDialog {...props({ inspection: { checkpoint: newest, files: [] }, onInspect })} />,
    )
    onInspect.mockClear()
    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    expect(onInspect).not.toHaveBeenCalled()
    fireEvent.keyDown(panel, { key: 'ArrowUp' })
    expect(onInspect).toHaveBeenCalledWith(second)
  })

  it('starts the arrow keys from the newest prompt when nothing is picked', () => {
    const onInspect = vi.fn()
    const view = render(<RollbackDialog {...props({ onInspect })} />)
    const panel = view.container.querySelector<HTMLElement>('.rollback')!

    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    expect(onInspect).not.toHaveBeenCalled()
    fireEvent.keyDown(panel, { key: 'ArrowUp' })
    expect(onInspect).toHaveBeenCalledWith(newest)
  })

  it('locks the choice while restoring', () => {
    const onInspect = vi.fn()
    const view = render(
      <RollbackDialog
        {...props({ inspection: { checkpoint: second, files: [] }, restoring: true, onInspect })}
      />,
    )

    expect(restore().textContent).toBe('Restoring…')
    expect(restore().disabled).toBe(true)
    expect(prompt(first).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(view.container.querySelector('.rollback')!, { key: 'ArrowUp' })
    expect(onInspect).not.toHaveBeenCalled()
  })
})
