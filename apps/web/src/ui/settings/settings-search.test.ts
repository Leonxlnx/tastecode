// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { ProviderStatus } from '@harness/contracts'
import { TUNING_LABELS, providerTuningEntries, tuningSearchId } from './provider-tuning-search.js'
import { KEYBINDING_DEFINITIONS } from '../../shortcuts.js'
import { searchSettings, SETTINGS_SEARCH_ENTRIES, STATIC_SETTINGS } from './settings-search.js'

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

  it('keeps the catalog and row anchors in sync', () => {
    const ids = new Set<string>()
    // These are named entities, a loading placeholder, or live status, not fixed settings.
    const exempt: Record<string, string[]> = {
      'Settings.tsx': ['key={row}'],
      'ModelLabSection.tsx': ['className="model-lab__head"'],
      'ModelVisibilityControls.tsx': ['name={name}'],
      'ProfileAccounts.tsx': ['key={status.id}', 'providerMark(account.provider)'],
      'PhoneSettings.tsx': ['name="Reachable at"'],
    }
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
            const signature = (exempt[file] ?? []).find((value) =>
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
        [...(exempt[file] ?? [])].sort(),
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
