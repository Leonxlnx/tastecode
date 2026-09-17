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
    fireEvent.keyDown(recorder, { key: 'G', metaKey: true, shiftKey: true })
    expect(recorder.querySelector('kbd')?.title).toBe('⌘⇧G')
    expect(recorder.querySelector('[data-shortcut-icon="command"]')).toBeTruthy()
    expect(recorder.querySelector('[data-shortcut-icon="shift"]')).toBeTruthy()
    expect(recorder.querySelector('.keybind-shortcut__key')?.textContent).toBe('G')

    fireEvent.click(screen.getByRole('button', { name: 'Clear Command palette keybind' }))
    expect(recorder.textContent).toBe('Set keybind')
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
    expect(recorder.textContent).toBe('Press keys…')

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

    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    expect(onReset).toHaveBeenCalledOnce()
    expect(recorder.querySelector('kbd')?.title).toBe('⌘K')
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
