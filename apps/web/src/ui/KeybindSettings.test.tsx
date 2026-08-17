// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requiredValue } from '../test-dom.js'
import {
  createDefaultKeybindings,
  type KeybindingId,
  type Keybindings,
  type Shortcut,
} from '../shortcuts.js'
import { KeybindSettings } from './KeybindSettings.js'

function StatefulKeybindSettings(props: { onReset?: () => void }) {
  const [keybindings, setKeybindings] = useState<Keybindings>(createDefaultKeybindings)
  const change = (action: KeybindingId, shortcut: Shortcut | null) => {
    setKeybindings((current) => ({ ...current, [action]: shortcut }))
  }
  return (
    <KeybindSettings
      keybindings={keybindings}
      macOS={true}
      onChange={change}
      onReset={() => {
        props.onReset?.()
        setKeybindings(createDefaultKeybindings())
      }}
    />
  )
}

afterEach(cleanup)

describe('keybind settings', () => {
  it('groups the app actions and filters them with the native settings search', () => {
    render(<StatefulKeybindSettings />)

    expect(screen.getByRole('heading', { name: 'Keybinds' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'App' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change Command palette keybind' }).textContent).toBe(
      '⌘K',
    )

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
    expect(recorder.textContent).toBe('⌘⇧G')

    fireEvent.click(screen.getByRole('button', { name: 'Clear Command palette keybind' }))
    expect(recorder.textContent).toBe('Set keybind')
  })

  it('keeps recording when a keybind conflicts or has no safe modifier', () => {
    render(<StatefulKeybindSettings />)
    const row = requiredValue(
      screen.getByText('New chat').closest<HTMLElement>('.keybind-row'),
      'New chat keybind row',
    )
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
    expect(recorder.textContent).toBe('⌘G')

    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    expect(onReset).toHaveBeenCalledOnce()
    expect(recorder.textContent).toBe('⌘K')
  })
})
