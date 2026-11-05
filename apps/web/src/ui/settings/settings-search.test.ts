// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { ProviderStatus } from '@harness/contracts'
import {
  EXECUTABLE_PATH_LABEL,
  executablePathEntries,
  executablePathSearchId,
  TUNING_LABELS,
  providerTuningEntries,
  tuningSearchId,
} from './provider-tuning-search.js'
import { KEYBINDING_DEFINITIONS } from '../../shortcuts.js'
import {
  searchSettings,
  SETTINGS_PAGES,
  SETTINGS_SEARCH_ENTRIES,
  STATIC_SETTINGS,
} from './settings-search.js'

const files = [
  'Settings.tsx',
  'GeneralSettings.tsx',
  'KeybindSettings.tsx',
  'AppBackgroundSettings.tsx',
  'ModelLabSection.tsx',
  'ModelVisibilityControls.tsx',
  'PhoneSettings.tsx',
  'ProfileAccounts.tsx',
  'ProfileSettings.tsx',
]
const source = (file: string) => readFileSync(resolve(process.cwd(), 'src/ui', file), 'utf8')

describe('settings search', () => {
  it('matches every word in any order and ranks titles before keywords and descriptions', () => {
    const entries = [
      {
        id: 'description',
        section: 'appearance' as const,
        title: 'Other',
        description: 'dark mode',
      },
      { id: 'keyword', section: 'appearance' as const, title: 'Theme', keywords: 'dark mode' },
      { id: 'title', section: 'appearance' as const, title: 'Dark mode' },
    ]
    expect(searchSettings('MODE dark', entries).map((entry) => entry.id)).toEqual([
      'title',
      'keyword',
      'description',
    ])
    expect(searchSettings('dark missing', entries)).toEqual([])
    expect(
      searchSettings('dark mode', [
        { id: 'keywords', section: 'appearance', title: 'Other', keywords: 'dark mode' },
        { id: 'mixed', section: 'appearance', title: 'Dark', description: 'mode' },
      ]).map((entry) => entry.id),
    ).toEqual(['mixed', 'keywords'])
  })

  it('matches row descriptions and checks conditional background controls', () => {
    expect(searchSettings('reparses history', STATIC_SETTINGS).map((entry) => entry.id)).toContain(
      'debug-usage',
    )
    const speed = STATIC_SETTINGS.find((entry) => entry.id === 'background-speed')!
    const context = {
      phone: false,
      debug: false,
      desktop: false,
      notifications: false,
      haptics: false,
      fontSmoothing: false,
      backgroundMode: 'none',
      backgroundImage: false,
      material: false,
      backgroundEffort: false,
      backgroundSpeed: false,
    }
    expect(speed.visible?.(context)).toBe(false)
    expect(speed.visible?.({ ...context, backgroundSpeed: true })).toBe(true)
  })

  it('generates provider defaults from the same labels used by the rows', () => {
    const provider = {
      id: 'codex',
      displayName: 'Agent',
      installed: true,
      auth: 'authenticated',
    } as ProviderStatus
    const entries = providerTuningEntries([provider], [], new Map([['codex', { signedIn: true }]]))
    expect(entries.map((entry) => entry.id)).toEqual([
      tuningSearchId('codex', 'Agent', TUNING_LABELS.model),
      tuningSearchId('codex', 'Agent', TUNING_LABELS.access),
    ])
    expect(providerTuningEntries([provider], [], new Map())).toEqual([])
  })

  // #2175 added a per-provider executable path; search did not know it.
  it('finds each CLI provider executable path by the label and anchor of its control', () => {
    const statuses = [
      { id: 'codex', displayName: 'Codex', installed: true, auth: 'authenticated' },
      { id: 'cursor', displayName: 'Cursor', installed: false, auth: 'unknown' },
      { id: 'api', displayName: 'API', installed: true, auth: 'unknown' },
    ] as ProviderStatus[]
    const entries = executablePathEntries(statuses)
    expect(entries.map((entry) => entry.id)).toEqual([
      executablePathSearchId('codex'),
      executablePathSearchId('cursor'),
    ])
    expect(searchSettings('codex executable', entries).map((entry) => entry.id)).toEqual([
      executablePathSearchId('codex'),
    ])
    expect(searchSettings('cli binary', entries)).toHaveLength(2)
    const control = source('ProviderExecutablePath.tsx')
    expect(control).toContain('data-settings-id={executablePathSearchId(props.source)}')
    expect(control).toContain('{EXECUTABLE_PATH_LABEL}')
    expect(EXECUTABLE_PATH_LABEL).toBe('Executable path')
  })

  it('offers every category in the settings rail, ahead of the rows that share its words', () => {
    const labels = [
      ...source('Settings.tsx').matchAll(/<SettingsNavItem[\s\S]*?label="([^"]+)"/g),
    ].map((match) => match[1])
    expect(labels.length).toBeGreaterThan(10)
    expect(SETTINGS_PAGES.map((entry) => entry.title).sort()).toEqual([...labels].sort())
    expect(searchSettings('model', SETTINGS_SEARCH_ENTRIES)[0]?.title).toBe('Models')
    expect(searchSettings('mcp', SETTINGS_SEARCH_ENTRIES)[0]?.title).toBe('MCP servers')
  })

  it('keeps the catalog and row anchors in sync', () => {
    const ids = new Set<string>()
    // These are named entities, a loading placeholder, or live status, not fixed settings.
    const exempt = new Map([
      ['Settings.tsx', ['key={row}']],
      ['ModelLabSection.tsx', ['className="model-lab__head"']],
      ['ModelVisibilityControls.tsx', ['name={name}']],
      ['ProfileAccounts.tsx', ['key={status.id}', 'providerMark(account.provider)']],
      ['PhoneSettings.tsx', ['name="Reachable at"']],
    ])
    for (const file of files) {
      const text = source(file)
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const missing: string[] = []
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
          const anchor = attributes.find((attr) =>
            ['searchId', 'data-settings-id'].includes(attr.name.getText(tree)),
          )
          if (node.tagName.getText(tree) === 'SettingsRow' && !anchor) {
            const signature = (exempt.get(file) ?? []).find((value) =>
              node.getText(tree).includes(value),
            )
            missing.push(signature ?? node.getText(tree))
          }
          if (anchor?.initializer && ts.isStringLiteral(anchor.initializer))
            ids.add(anchor.initializer.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
      expect(missing.sort(), `${file}: unexpected row without a searchId`).toEqual(
        [...(exempt.get(file) ?? [])].sort(),
      )
    }
    for (const entry of STATIC_SETTINGS) expect(ids.has(entry.id), entry.id).toBe(true)
    for (const id of ids)
      expect(
        STATIC_SETTINGS.some((entry) => entry.id === id),
        id,
      ).toBe(true)
    expect(source('KeybindSettings.tsx')).toContain('`keybind:${definition.id}`')
    for (const label of Object.keys(TUNING_LABELS))
      expect(source('ProviderTuning.tsx')).toContain(
        `tuningSearchId(id, name, TUNING_LABELS.${label})`,
      )
    for (const definition of KEYBINDING_DEFINITIONS)
      expect(SETTINGS_SEARCH_ENTRIES.some((entry) => entry.id === `keybind:${definition.id}`)).toBe(
        true,
      )
    expect(source('Settings.tsx')).toContain('`appearance:${props.mode}:accent`')
    for (const mode of ['light', 'dark'])
      for (const setting of ['accent', 'background', 'interface-font', 'sidebar-translucency']) {
        expect(
          SETTINGS_SEARCH_ENTRIES.some((entry) => entry.id === `appearance:${mode}:${setting}`),
        ).toBe(true)
        expect(source('Settings.tsx')).toContain(`\`appearance:\${props.mode}:${setting}\``)
      }
  })
})
