// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandPalette,
  MAX_VISIBLE_PALETTE_COMMANDS,
  type PaletteCommand,
} from './CommandPalette.js'

afterEach(cleanup)

function makeCommands() {
  const ran: string[] = []
  const commands: PaletteCommand[] = [
    { id: 'new-chat', title: 'New chat', group: 'Actions', run: () => ran.push('new-chat') },
    { id: 'settings', title: 'Settings', group: 'Actions', run: () => ran.push('settings') },
    {
      id: 'proj-a',
      title: 'Project A',
      group: 'Projects',
      projectCommand: true,
      run: () => ran.push('proj-a'),
    },
    {
      id: 'new-thread-a',
      title: 'New thread in Project A',
      group: 'Projects',
      newThreadProject: true,
      run: () => ran.push('new-thread-a'),
    },
    {
      id: 'new-thread-b',
      title: 'New thread in Project B',
      group: 'Projects',
      newThreadProject: true,
      run: () => ran.push('new-thread-b'),
    },
  ]
  return { commands, ran }
}

describe('CommandPalette', () => {
  it('keeps the list at the top when it opens instead of clipping the first group', () => {
    const { commands } = makeCommands()
    const scrollTo = vi.fn()
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    render(<CommandPalette commands={commands} scope="all" onClose={vi.fn()} />)

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search commands' }), {
      key: 'ArrowDown',
    })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('filters commands and runs the selection on Enter', () => {
    const { commands, ran } = makeCommands()
    const onClose = vi.fn()
    render(<CommandPalette commands={commands} scope="all" onClose={onClose} />)

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'sett' } })
    expect(screen.queryByText('New chat')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(ran).toEqual(['settings'])
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps hover highlight and Enter target in sync', () => {
    const { commands, ran } = makeCommands()
    render(<CommandPalette commands={commands} scope="all" onClose={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    const target = screen.getByRole('option', { name: 'Settings' })
    fireEvent.mouseMove(target)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(target.getAttribute('aria-selected')).toBe('true')
    expect(ran).toEqual(['settings'])
  })

  it('keeps the keyboard selection when the list scrolls under a resting pointer', () => {
    const { commands } = makeCommands()
    render(<CommandPalette commands={commands} scope="all" onClose={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.mouseEnter(screen.getByRole('option', { name: /^Project A/ }))

    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Settings')
  })

  it('returns from a project list with the back arrow or Backspace on an empty search', () => {
    const { commands } = makeCommands()
    const onBack = vi.fn()
    const { rerender } = render(
      <CommandPalette commands={commands} scope="projects" onBack={onBack} onClose={vi.fn()} />,
    )

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onBack).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onBack).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Back to all commands' }))
    expect(onBack).toHaveBeenCalledTimes(2)

    // The root list has nowhere to go back to.
    rerender(<CommandPalette commands={commands} scope="all" onBack={onBack} onClose={vi.fn()} />)
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onBack).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Back to all commands' })).toBeNull()
  })

  it('starts each list with an empty search', () => {
    const { commands } = makeCommands()
    const { rerender } = render(
      <CommandPalette commands={commands} scope="all" onClose={vi.fn()} />,
    )
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'project' } })

    rerender(<CommandPalette commands={commands} scope="new-thread" onClose={vi.fn()} />)

    expect(input.value).toBe('')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('shows the emphasised name, sub-list marker, and project details', () => {
    const run = vi.fn()
    render(
      <CommandPalette
        commands={[
          {
            id: 'new',
            title: 'New thread in',
            emphasis: 'Alpha',
            detail: 'Start in Alpha',
            group: 'Actions',
            run,
          },
          { id: 'switch', title: 'Switch project…', group: 'Actions', submenu: true, run },
          { id: 'alpha', title: 'Alpha', detail: '/work/alpha', group: 'Projects', run },
        ]}
        scope="all"
        onClose={vi.fn()}
      />,
    )

    const newThread = screen.getByRole('option', { name: 'New thread in Alpha' })
    expect(newThread.querySelector('strong')?.textContent).toBe('Alpha')
    // Actions stay on one line; their detail is only searchable.
    expect(screen.queryByText('Start in Alpha')).toBeNull()
    expect(
      screen.getByRole('option', { name: 'Switch project…' }).getAttribute('aria-haspopup'),
    ).toBe('listbox')
    expect(screen.getByText('/work/alpha')).toBeTruthy()
  })

  it('limits the projects scope to project commands', () => {
    const { commands } = makeCommands()
    render(<CommandPalette commands={commands} scope="projects" onClose={vi.fn()} />)

    expect(screen.getByText('Project A')).toBeTruthy()
    expect(screen.queryByText('New chat')).toBeNull()
  })

  it('shows only new-thread destinations and puts the preferred project first', () => {
    const { commands } = makeCommands()
    render(
      <CommandPalette
        commands={commands}
        scope="new-thread"
        preferredCommandId="new-thread-b"
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Choose a project for the new thread' })).toBeTruthy()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'New thread in Project B',
      'New thread in Project A',
    ])
  })

  it('bounds a large initial result list and still finds commands beyond it', () => {
    const commands: PaletteCommand[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      group: 'Chats',
      run: vi.fn(),
    }))
    render(<CommandPalette commands={commands} scope="all" onClose={vi.fn()} />)

    expect(screen.getAllByRole('option')).toHaveLength(MAX_VISIBLE_PALETTE_COMMANDS)
    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'Chat 9999' } })

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Chat 9999')).toBeTruthy()
  })

  it('materializes only bounded deferred chat matches', () => {
    const deferredSearch = vi.fn((terms: readonly string[], limit: number) =>
      Array.from({ length: Math.min(limit, terms.length > 0 ? 1 : 10_000) }, (_, index) => ({
        id: `deferred-${index}`,
        title: terms.length > 0 ? 'Deferred needle' : `Deferred ${index}`,
        group: 'Chats' as const,
        run: vi.fn(),
      })),
    )
    render(
      <CommandPalette
        commands={[]}
        scope="all"
        deferredSearch={deferredSearch}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('option')).toHaveLength(MAX_VISIBLE_PALETTE_COMMANDS)
    expect(deferredSearch).toHaveBeenLastCalledWith([], MAX_VISIBLE_PALETTE_COMMANDS)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search commands' }), {
      target: { value: 'deferred needle' },
    })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(deferredSearch).toHaveBeenLastCalledWith(
      ['deferred', 'needle'],
      MAX_VISIBLE_PALETTE_COMMANDS,
    )
  })

  it('traps focus and restores it after closing', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { commands } = makeCommands()
    const view = render(<CommandPalette commands={commands} scope="all" onClose={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Search commands' })

    expect(document.activeElement).toBe(input)
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(input)

    view.unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
