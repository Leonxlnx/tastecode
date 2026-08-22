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
