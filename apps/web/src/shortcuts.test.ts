// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockKeyboardModifierState } from './test-keyboard.js'
import {
  createDefaultKeybindings,
  FIND_IN_CHAT_SHORTCUT,
  findKeybindingConflict,
  isComposingKey,
  isConfirmEnter,
  isEditableTarget,
  KEYBINDING_STORAGE_KEY,
  KEYBINDING_DEFINITIONS,
  matchesShortcut,
  PREVIOUS_TURN_SHORTCUT,
  readKeybindings,
  reservedShortcutLabel,
  shortcutAria,
  shortcutFromKeyboardEvent,
  shortcutLabel,
  shortcutRoute,
  WORKSPACE_TOOL_SHORTCUTS,
  writeKeybindings,
  type Shortcut,
} from './shortcuts.js'

beforeEach(mockKeyboardModifierState)
const onPlatform = (platform: string) =>
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('shortcuts', () => {
  it('lets an open sheet or dialog own app shortcuts', () => {
    const closed = { settingsOpen: false, onboardingPreview: false, modalOpen: false }
    expect(shortcutRoute('commandPalette', closed)).toBe('run')
    expect(shortcutRoute('settings', { ...closed, settingsOpen: true })).toBe('closeSettings')
    expect(shortcutRoute('keybindings', { ...closed, settingsOpen: true })).toBe('showKeybinds')
    expect(shortcutRoute('commandPalette', { ...closed, settingsOpen: true })).toBe('ignore')
    expect(shortcutRoute('newChat', { ...closed, modalOpen: true })).toBe('ignore')
    expect(shortcutRoute('newChat', { ...closed, onboardingPreview: true })).toBe('ignore')
  })

  it('offers broad action coverage without duplicate default bindings', () => {
    const keybindings = createDefaultKeybindings()
    const assigned = KEYBINDING_DEFINITIONS.flatMap((definition) => {
      const shortcut = keybindings[definition.id]
      return shortcut ? [shortcutLabel(shortcut, false)] : []
    })

    expect(KEYBINDING_DEFINITIONS).toHaveLength(23)
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('matches Ctrl as the primary modifier outside macOS without stealing shifted variants', () => {
    onPlatform('Win32')
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

  it('leaves Ctrl+letter to text editing on macOS', () => {
    onPlatform('MacIntel')
    const keybindings = createDefaultKeybindings()
    const press = (key: string, init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', { key, ...init })
    expect(matchesShortcut(press('k', { metaKey: true }), keybindings.commandPalette)).toBe(true)
    expect(matchesShortcut(press('k', { ctrlKey: true }), keybindings.commandPalette)).toBe(false)
    expect(matchesShortcut(press('n', { ctrlKey: true }), keybindings.newChat)).toBe(false)
    expect(matchesShortcut(press('f', { ctrlKey: true }), FIND_IN_CHAT_SHORTCUT)).toBe(false)
    expect(
      matchesShortcut(press('ArrowUp', { ctrlKey: true, altKey: true }), PREVIOUS_TURN_SHORTCUT),
    ).toBe(false)
    expect(matchesShortcut(press('ArrowUp', { altKey: true }), PREVIOUS_TURN_SHORTCUT)).toBe(true)
  })

  it('records Command but not Ctrl as the primary modifier on macOS', () => {
    onPlatform('MacIntel')
    expect(
      shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })),
    ).toEqual({ key: 'k', primary: true })
    expect(
      shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })),
    ).toBeUndefined()
    expect(
      shortcutFromKeyboardEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true }),
      ),
    ).toBeUndefined()
  })

  it('formats platform-native hints and recognizes every editable target', () => {
    const newProject = createDefaultKeybindings().newProject!
    expect(shortcutLabel(newProject, true)).toBe('⌘⇧O')
    expect(shortcutLabel(newProject, false)).toBe('Ctrl+Shift+O')
    expect(shortcutLabel({ key: 'arrowdown', primary: true, alt: true }, false)).toBe('Ctrl+Alt+↓')
    expect(shortcutLabel({ key: 'escape', primary: true }, false)).toBe('Ctrl+Esc')
    expect(shortcutLabel({ key: 'delete', primary: true, shift: true }, false)).toBe(
      'Ctrl+Shift+Del',
    )
    expect(shortcutAria({ key: 'arrowdown', primary: true, alt: true })).toBe(
      'Meta+Alt+ArrowDown Control+Alt+ArrowDown',
    )
    expect(shortcutLabel({ key: 'enter', primary: true }, false)).toBe('Ctrl+Enter')
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

  it('names the owner of each chord the app keeps for itself', () => {
    expect(reservedShortcutLabel({ key: '1', primary: true })).toBe('Open recent chat')
    expect(reservedShortcutLabel({ key: '9', primary: true })).toBe('Open recent chat')
    expect(reservedShortcutLabel({ key: 'd', primary: true, alt: true, shift: true })).toBe(
      'Debug settings',
    )
    expect(reservedShortcutLabel({ key: 'f', primary: true })).toBe('Find in chat')
    expect(reservedShortcutLabel({ key: 'arrowup', alt: true })).toBe('Previous turn')
    expect(reservedShortcutLabel({ key: 'arrowdown', alt: true })).toBe('Next turn')
    for (const tool of WORKSPACE_TOOL_SHORTCUTS) {
      expect(reservedShortcutLabel(tool.shortcut)).toBe(tool.label)
    }
    expect(reservedShortcutLabel({ key: '0', primary: true })).toBeUndefined()
    expect(reservedShortcutLabel({ key: '1', primary: true, shift: true })).toBeUndefined()
    expect(reservedShortcutLabel({ key: '1', alt: true })).toBeUndefined()
    expect(reservedShortcutLabel({ key: 't', primary: true, shift: true })).toBeUndefined()
    for (const shortcut of Object.values(createDefaultKeybindings())) {
      if (shortcut) expect(reservedShortcutLabel(shortcut)).toBeUndefined()
    }
  })

  it.each([
    ['macOS', 'MacIntel'],
    ['Windows', 'Win32'],
    ['Linux', 'Linux x86_64'],
  ])('matches all assigned shortcuts on %s', (platform, navigatorPlatform) => {
    onPlatform(navigatorPlatform)
    const shortcuts: Shortcut[] = [
      ...Object.values(createDefaultKeybindings()).filter((shortcut) => shortcut !== null),
      ...WORKSPACE_TOOL_SHORTCUTS.map(({ shortcut }) => shortcut),
    ]
    for (const shortcut of shortcuts) {
      const event = new KeyboardEvent('keydown', {
        key: shortcut.key,
        ...(platform === 'macOS'
          ? { metaKey: !!shortcut.primary }
          : { ctrlKey: !!shortcut.primary }),
        altKey: !!shortcut.alt,
        shiftKey: !!shortcut.shift,
      })
      expect(matchesShortcut(event, shortcut), shortcutLabel(shortcut, false)).toBe(true)
    }
  })

  it.each([
    { key: 'π', code: 'KeyP', altKey: true, base: 'p' },
    { key: 'Dead', code: 'KeyE', altKey: true, base: 'e' },
    { key: 'Î', code: 'KeyD', altKey: true, shiftKey: true, base: 'd' },
    { key: '?', code: 'Slash', shiftKey: true, base: '/' },
  ])('keeps the base key portable when recording $code', ({ base, ...keys }) => {
    const macEvent = new KeyboardEvent('keydown', { ...keys, metaKey: true })
    const shortcut = shortcutFromKeyboardEvent(macEvent)!
    expect(shortcut.key).toBe(base)
    expect(matchesShortcut(macEvent, shortcut)).toBe(true)
    const ctrlEvent = new KeyboardEvent('keydown', { ...keys, key: base, ctrlKey: true })
    expect(matchesShortcut(ctrlEvent, shortcut)).toBe(true)
    expect(shortcutFromKeyboardEvent(ctrlEvent)).toEqual(shortcut)
  })

  it('does not record a dead key it cannot resolve to a base key', () => {
    expect(
      shortcutFromKeyboardEvent(
        new KeyboardEvent('keydown', { key: 'Dead', code: 'Equal', ctrlKey: true }),
      ),
    ).toBeUndefined()
  })

  it('preserves keyboard-layout letters and existing symbol bindings', () => {
    expect(
      shortcutFromKeyboardEvent(
        new KeyboardEvent('keydown', {
          key: 'a',
          code: 'KeyQ',
          ctrlKey: true,
          altKey: true,
        }),
      ),
    ).toEqual({ key: 'a', primary: true, alt: true })
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', {
          key: '?',
          code: 'Slash',
          ctrlKey: true,
          shiftKey: true,
        }),
        { key: '?', primary: true, shift: true },
      ),
    ).toBe(true)
  })

  it('confirms on Enter only outside an IME composition', () => {
    const enter = (key: string, isComposing: boolean) =>
      isConfirmEnter({ key, nativeEvent: new KeyboardEvent('keydown', { key, isComposing }) })
    expect(enter('Enter', false)).toBe(true)
    expect(enter('Enter', true)).toBe(false)
    expect(enter('a', false)).toBe(false)
  })

  it('recognises keys that belong to an open IME composition', () => {
    const composing = (init: KeyboardEventInit) =>
      isComposingKey(new KeyboardEvent('keydown', { key: 'Escape', ...init }))
    expect(composing({ isComposing: true })).toBe(true)
    expect(composing({ keyCode: 229 })).toBe(true)
    expect(composing({})).toBe(false)
    expect(
      isComposingKey({
        nativeEvent: new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }),
      }),
    ).toBe(true)
  })

  it('does not capture AltGr, composition, or unsupported mixed primary modifiers', () => {
    for (const event of [
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, isComposing: true }),
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true }),
      {
        key: 'k',
        ctrlKey: true,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        getModifierState: (key: string) => key === 'AltGraph',
      },
    ]) {
      expect(shortcutFromKeyboardEvent(event)).toBeUndefined()
      expect(matchesShortcut(event, { key: 'k', primary: true, alt: event.altKey })).toBe(false)
    }
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
