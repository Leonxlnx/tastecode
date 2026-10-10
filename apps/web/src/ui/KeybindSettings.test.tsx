// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockKeyboardModifierState } from '../test-keyboard.js'
import {
  createDefaultKeybindings,
  type KeybindingId,
  type Keybindings,
  type Shortcut,
} from '../shortcuts.js'
import { KeybindSettings } from './KeybindSettings.js'

const { suspendNativeMenuShortcuts } = vi.hoisted(() => ({ suspendNativeMenuShortcuts: vi.fn() }))
vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  suspendNativeMenuShortcuts,
}))

function StatefulKeybindSettings(props: { macOS?: boolean; onReset?: () => void }) {
  const [keybindings, setKeybindings] = useState<Keybindings>(createDefaultKeybindings)
  const change = (action: KeybindingId, shortcut: Shortcut | null) => {
    setKeybindings((current) => ({ ...current, [action]: shortcut }))
  }
  return (
    <KeybindSettings
      keybindings={keybindings}
      macOS={props.macOS ?? true}
      onChange={change}
      onReset={() => {
        props.onReset?.()
        setKeybindings(createDefaultKeybindings())
      }}
    />
  )
}

beforeEach(mockKeyboardModifierState)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('keybind settings', () => {
  it('groups the app actions and filters them with the native settings search', () => {
    render(<StatefulKeybindSettings />)

    expect(screen.getByRole('heading', { name: 'Keybinds' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'App' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy()
    const commandPalette = screen.getByRole('button', {
      name: 'Change Command palette keybind',
    })
    expect(commandPalette.querySelector('kbd')?.title).toBe('⌘K')
    expect(commandPalette.querySelector('[data-shortcut-icon="command"]')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search keybinds' }), {
      target: { value: 'terminal' },
    })
    expect(screen.getByText('Toggle terminal')).toBeTruthy()
    expect(screen.queryByText('Command palette')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Chats' })).toBeNull()
  })

  it('records a new keybind and supports clearing it', () => {
    render(<StatefulKeybindSettings />)
    const recorder = screen.getByRole('button', { name: 'Change Command palette keybind' })

    fireEvent.click(recorder)
    expect(recorder.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(recorder, { key: 'Y', metaKey: true, shiftKey: true })
    expect(recorder.querySelector('kbd')?.title).toBe('⌘⇧Y')
    expect(recorder.querySelector('[data-shortcut-icon="command"]')).toBeTruthy()
    expect(recorder.querySelector('[data-shortcut-icon="shift"]')).toBeTruthy()
    expect(recorder.querySelector('.keybind-shortcut__key')?.textContent).toBe('Y')

    expect(screen.queryByRole('button', { name: 'Clear Command palette keybind' })).toBeNull()
    fireEvent.click(recorder)
    fireEvent.click(screen.getByRole('button', { name: 'Clear Command palette keybind' }))
    expect(recorder.getAttribute('aria-pressed')).toBe('false')
    expect(recorder.textContent).toBe('Not set')
  })

  it('lights each modifier while it is held', () => {
    render(<StatefulKeybindSettings />)
    const recorder = screen.getByRole('button', { name: 'Change New chat keybind' })
    fireEvent.click(recorder)
    const held = () =>
      [...recorder.querySelectorAll('.keybind-shortcut__modifier[data-held]')].map(
        (modifier) => modifier.textContent,
      )

    expect(held()).toEqual([])
    fireEvent.keyDown(recorder, { key: 'Meta', metaKey: true })
    fireEvent.keyDown(recorder, { key: 'Shift', metaKey: true, shiftKey: true })
    expect(held()).toEqual(['⌘', '⇧'])
    fireEvent.keyUp(recorder, { key: 'Shift', metaKey: true })
    expect(held()).toEqual(['⌘'])
  })

  it('turns native menu accelerators off only while recording', () => {
    suspendNativeMenuShortcuts.mockClear()
    const view = render(<StatefulKeybindSettings />)
    const recorder = screen.getByRole('button', { name: 'Change New chat keybind' })

    fireEvent.click(recorder)
    expect(suspendNativeMenuShortcuts.mock.calls).toEqual([[true]])
    fireEvent.keyDown(recorder, { key: 'k', metaKey: true })
    expect(suspendNativeMenuShortcuts.mock.calls).toEqual([[true]])
    fireEvent.keyDown(recorder, { key: 'Escape' })
    expect(suspendNativeMenuShortcuts.mock.calls).toEqual([[true], [false]])

    fireEvent.click(recorder)
    view.unmount()
    expect(suspendNativeMenuShortcuts.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it('keeps recording when a keybind conflicts or has no safe modifier', () => {
    render(<StatefulKeybindSettings />)
    const row = screen.getByText('New chat').closest<HTMLElement>('.keybind-row')!
    const recorder = within(row).getByRole('button', {
      name: 'Change New chat keybind',
    })

    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, { key: 'k', metaKey: true })
    expect(within(row).getByRole('alert').textContent).toBe('Already used by Command palette.')
    expect(recorder.getAttribute('aria-pressed')).toBe('true')
    expect(recorder.querySelector('kbd')?.title).toBe('⌘K')

    fireEvent.keyDown(recorder, { key: 'g' })
    expect(within(row).getByRole('alert').textContent).toContain('Add Command')
  })

  it('restores every default from one reset action', () => {
    const onReset = vi.fn()
    render(<StatefulKeybindSettings onReset={onReset} />)
    const recorder = screen.getByRole('button', { name: 'Change Command palette keybind' })
    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, { key: 'g', metaKey: true })
    expect(recorder.querySelector('kbd')?.title).toBe('⌘G')

    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    expect(onReset).toHaveBeenCalledOnce()
    expect(recorder.querySelector('kbd')?.title).toBe('⌘K')
    expect(screen.queryByRole('button', { name: 'Restore defaults' })).toBeNull()
  })

  it.each([
    ['a recent chat number', { key: '1', metaKey: true }, '⌘1', 'Open recent chat'],
    ['a workspace tool', { key: 't', metaKey: true }, '⌘T', 'Open Browser'],
    [
      'the debug chord',
      { key: 'Î', code: 'KeyD', metaKey: true, altKey: true, shiftKey: true },
      '⌘⌥⇧D',
      'Debug settings',
    ],
  ])('refuses %s that the app keeps for itself', (_name, keys, title, owner) => {
    const onChange = vi.fn()
    render(
      <KeybindSettings
        keybindings={createDefaultKeybindings()}
        macOS
        onChange={onChange}
        onReset={() => {}}
      />,
    )
    const row = screen.getByText('New chat').closest<HTMLElement>('.keybind-row')!
    const recorder = within(row).getByRole('button', { name: 'Change New chat keybind' })

    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, keys)

    expect(within(row).getByRole('alert').textContent).toBe(`Already used by ${owner}.`)
    expect(recorder.getAttribute('aria-pressed')).toBe('true')
    expect(recorder.querySelector('kbd')?.title).toBe(title)
    expect(within(row).queryByRole('button', { name: 'Move it here' })).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves a taken shortcut to the action being recorded', () => {
    render(<StatefulKeybindSettings />)
    const newChat = screen.getByRole('button', { name: 'Change New chat keybind' })
    const palette = screen.getByRole('button', { name: 'Change Command palette keybind' })

    fireEvent.click(newChat)
    fireEvent.keyDown(newChat, { key: 'k', metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Move it here' }))

    expect(newChat.querySelector('kbd')?.title).toBe('⌘K')
    expect(palette.textContent).toBe('Not set')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('restores one action to its default without touching the rest', () => {
    render(<StatefulKeybindSettings />)
    const newChat = screen.getByRole('button', { name: 'Change New chat keybind' })
    const palette = screen.getByRole('button', { name: 'Change Command palette keybind' })
    fireEvent.click(palette)
    fireEvent.keyDown(palette, { key: 'g', metaKey: true })
    fireEvent.click(newChat)
    fireEvent.keyDown(newChat, { key: 'j', metaKey: true, shiftKey: true })

    fireEvent.click(newChat)
    fireEvent.click(screen.getByRole('button', { name: 'Restore ⌘N' }))
    expect(newChat.querySelector('kbd')?.title).toBe('⌘N')
    expect(palette.querySelector('kbd')?.title).toBe('⌘G')
  })

  it('clears the search with its own action', () => {
    render(<StatefulKeybindSettings />)
    const search = screen.getByRole('searchbox', { name: 'Search keybinds' })
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByRole('status').textContent).toBe('No action matches “zzz”.')

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect((search as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Command palette')).toBeTruthy()
  })

  it('shows Ctrl and Alt labels and records Windows/Linux shortcuts', () => {
    render(<StatefulKeybindSettings macOS={false} />)
    const commandPalette = screen.getByRole('button', {
      name: 'Change Command palette keybind',
    })

    expect(commandPalette.querySelector('kbd')?.title).toBe('Ctrl+K')
    expect(commandPalette.querySelector('kbd')?.textContent).toBe('Ctrl+K')

    const nextChat = screen.getByRole('button', { name: 'Change Next chat keybind' })
    expect(nextChat.querySelector('kbd')?.textContent).toBe('Ctrl+Alt+ArrowDown')
    expect(nextChat.querySelector('[data-shortcut-icon="option"]')).toBeNull()
    fireEvent.click(commandPalette)
    fireEvent.keyDown(commandPalette, { key: 'g', ctrlKey: true, altKey: true })
    expect(commandPalette.querySelector('kbd')?.textContent).toBe('Ctrl+Alt+G')
  })

  it('records the base key for a macOS Option symbol', () => {
    render(<StatefulKeybindSettings />)
    const recorder = screen.getByRole('button', { name: 'Change Command palette keybind' })
    fireEvent.click(recorder)
    fireEvent.keyDown(recorder, { key: 'π', code: 'KeyP', metaKey: true, altKey: true })
    expect(recorder.querySelector('kbd')?.title).toBe('⌘⌥P')
  })
})
