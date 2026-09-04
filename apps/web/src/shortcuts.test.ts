// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultKeybindings,
  findKeybindingConflict,
  isEditableTarget,
  KEYBINDING_STORAGE_KEY,
  KEYBINDING_DEFINITIONS,
  matchesShortcut,
  readKeybindings,
  shortcutFromKeyboardEvent,
  shortcutLabel,
  writeKeybindings,
} from './shortcuts.js'

afterEach(() => localStorage.clear())

describe('shortcuts', () => {
  it('offers broad action coverage without duplicate default bindings', () => {
    const keybindings = createDefaultKeybindings()
    const assigned = KEYBINDING_DEFINITIONS.flatMap((definition) => {
      const shortcut = keybindings[definition.id]
      return shortcut ? [shortcutLabel(shortcut, false)] : []
    })

    expect(KEYBINDING_DEFINITIONS).toHaveLength(22)
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('matches the primary modifier on macOS and Windows without stealing shifted variants', () => {
    const commandPalette = createDefaultKeybindings().commandPalette!
    expect(
      matchesShortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), commandPalette),
    ).toBe(true)
    expect(
      matchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }), commandPalette),
    ).toBe(true)
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, shiftKey: true }),
        commandPalette,
      ),
    ).toBe(false)
  })

  it('formats platform-native hints and recognizes every editable target', () => {
    const newProject = createDefaultKeybindings().newProject!
    expect(shortcutLabel(newProject, true)).toBe('⌘⇧O')
    expect(shortcutLabel(newProject, false)).toBe('Ctrl+Shift+O')
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('input'))).toBe(true)

    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(isEditableTarget(editable)).toBe(true)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
  })

  it('captures modified keys, arrow keys, and standalone function keys', () => {
    expect(
      shortcutFromKeyboardEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true, altKey: true }),
      ),
    ).toEqual({ key: 'arrowdown', primary: true, alt: true })
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'F8' }))).toEqual({
      key: 'f8',
    })
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'a' }))).toBeUndefined()
  })

  it('persists only overrides while retaining unassigned actions', () => {
    const keybindings = createDefaultKeybindings()
    keybindings.commandPalette = { key: 'g', primary: true, shift: true }
    keybindings.newChat = null
    writeKeybindings(keybindings)

    expect(JSON.parse(localStorage.getItem(KEYBINDING_STORAGE_KEY) ?? '{}')).toEqual({
      version: 1,
      bindings: {
        commandPalette: { key: 'g', primary: true, shift: true },
        newChat: null,
      },
    })
    expect(readKeybindings()).toMatchObject({
      commandPalette: { key: 'g', primary: true, shift: true },
      newChat: null,
      settings: { key: ',', primary: true },
    })
  })

  it('falls back from malformed storage and finds conflicts by action', () => {
    localStorage.setItem(KEYBINDING_STORAGE_KEY, '{broken')
    expect(readKeybindings().commandPalette).toEqual(createDefaultKeybindings().commandPalette)

    const keybindings = createDefaultKeybindings()
    expect(findKeybindingConflict(keybindings, 'newChat', { key: 'k', primary: true })?.label).toBe(
      'Command palette',
    )
  })

  it('rejects stored keybindings that do not match the strict format', () => {
    const malformed = [
      { version: 1, bindings: {}, extra: true },
      { version: 1, bindings: { commandPalette: { key: 'g', primary: true, extra: true } } },
      { version: 1, bindings: { commandPalette: { key: 'g', primary: 'yes' } } },
      { version: 1, bindings: { commandPalette: { key: '' } } },
      { version: 1, bindings: { commandPalette: { key: 'x'.repeat(25) } } },
    ]

    for (const stored of malformed) {
      localStorage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify(stored))
      expect(readKeybindings()).toEqual(createDefaultKeybindings())
    }
  })

  it('ignores valid stored bindings for newer unknown actions', () => {
    localStorage.setItem(
      KEYBINDING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bindings: {
          futureAction: { key: 'f8' },
          commandPalette: { key: 'g', primary: true },
        },
      }),
    )

    expect(readKeybindings()).toMatchObject({
      commandPalette: { key: 'g', primary: true },
      settings: { key: ',', primary: true },
    })
  })
})
