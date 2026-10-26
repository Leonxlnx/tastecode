import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appDirectionForRun,
  appDirectionTokens,
  appDirectionTypefaces,
  appScreenKinds,
  appScreenRules,
  appScreenSource,
  appSheetGuidance,
  parseAppDirection,
  selectAppDirection,
  writeAppScreenKit,
} from './app-screens.js'
import type { DesignBrief } from './brief.js'

const library = new URL('../references/app-screens/', import.meta.url)
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const first = () => 0

function brief(originalRequest: string, extra: Partial<DesignBrief> = {}): DesignBrief {
  return {
    originalRequest,
    subject: '',
    pageType: 'dashboard',
    scope: 'One screen',
    primaryGoal: '',
    audience: '',
    offer: '',
    primaryAction: '',
    requiredContent: [],
    constraints: [],
    brandInputs: [],
    creativeControl: 'Agent decides',
    explicitAnswers: [],
    assumptions: [],
    unresolved: [],
    ...extra,
  }
}

describe('bundled tasteskill app library', () => {
  it('matches the recorded upstream files byte for byte', () => {
    const provenance = JSON.parse(readFileSync(new URL('provenance.json', library), 'utf8')) as {
      source: { version: string; commit: string }
      files: Array<{ path: string; sha256: string }>
    }
    expect(provenance.source).toMatchObject({
      version: '2.1.5',
      commit: '12af471f627f866411b4bd785b19646d3672784c',
    })
    for (const file of provenance.files) {
      const digest = createHash('sha256')
        .update(readFileSync(new URL(file.path, library)))
        .digest('hex')
      expect(digest, file.path).toBe(file.sha256)
    }
    expect(appScreenSource()).toBe('tasteskill v2.1.5')
  })
})

describe('app-screen deal', () => {
  it('reads the product kind from the brief, and falls back to the general kinds', () => {
    expect(appScreenKinds(brief('A household budget for two people with shared bills'))).toEqual([
      'finance',
    ])
    expect(appScreenKinds(brief('Deploy overview for our API platform with latency'))).toEqual([
      'devtools',
    ])
    expect(appScreenKinds(brief('Create an operating dashboard.'))).toEqual([
      'analytics',
      'smb-admin',
      'workspace',
    ])
  })

  it('deals a style, shell and one pattern per screen that suit the kind', () => {
    const direction = selectAppDirection(brief('Budget dashboard for our household'), first)
    expect(direction).toEqual({
      version: 1,
      source: 'tasteskill v2.1.5',
      kind: 'finance',
      style: 'achromatic-ledger',
      shell: 'open-plane',
      // No list pattern was written for finance; the sheet says to compose that screen.
      screens: [
        { name: 'overview', pattern: 'kpi-tabs-chart' },
        { name: 'list' },
        { name: 'settings', pattern: 'settings-two-column' },
      ],
      signatures: [],
    })
    expect(parseAppDirection(JSON.parse(JSON.stringify(direction)))).toEqual(direction)
  })

  it('keeps a named theme, adds named screens and finds signature elements', () => {
    const trading = selectAppDirection(brief('Dark mode trading desk with a watchlist'), first)
    expect(trading).toMatchObject({ kind: 'markets', theme: 'dark', style: 'true-black-flat' })
    const last = (length: number) => length - 1
    expect(
      selectAppDirection(brief('Dark mode trading desk with a watchlist'), last),
    ).toMatchObject({ theme: 'dark', style: 'data-terminal' })

    const leave = selectAppDirection(
      brief('Leave planner for the team: who is on holiday, plus settings', {
        requiredContent: ['Team calendar', 'Billing settings'],
      }),
      first,
    )
    expect(leave.signatures).toEqual(expect.arrayContaining(['leave-timeline']))
    expect(leave.screens.map(({ name }) => name)).toContain('settings')
  })

  it('draws uniformly at random by default and always parses', () => {
    for (let index = 0; index < 40; index++) {
      const direction = selectAppDirection(brief('Support inbox for our helpdesk'))
      expect(direction.kind).toBe('support')
      expect(parseAppDirection(direction)).toEqual(direction)
    }
  })

  it('deals only for dashboard runs without dashboard reference images', () => {
    const website = { ...brief('Landing page for our analytics app'), pageType: 'landing_page' }
    expect(appDirectionForRun(website, [], first)).toBeUndefined()
  })

  it('rejects a saved sheet that names something outside the bundled library', () => {
    const direction = selectAppDirection(brief('Analytics dashboard'), first)
    expect(() => parseAppDirection({ ...direction, style: 'neon-glass' })).toThrow(
      'Restart Design mode',
    )
    expect(() =>
      parseAppDirection({ ...direction, screens: [{ name: 'overview', pattern: 'chart-pairs' }] }),
    ).toThrow('screen pattern chart-pairs')
  })
})

describe('app sheet and rules', () => {
  it('renders the dealt sheet with tokens, type and shell, without tasteskill commands', () => {
    const direction = selectAppDirection(brief('Budget dashboard for our household'), first)
    const sheet = appSheetGuidance(direction)
    expect(sheet).toContain('APP SHEET: dealt by TasteCode from tasteskill v2.1.5')
    expect(sheet).toContain('1. The style: Achromatic ledger (achromatic-ledger, light)')
    expect(sheet).toContain('The move: No brand colour anywhere in the chrome')
    expect(sheet).toContain('  --ground: #f8f8f8;')
    expect(sheet).toContain('  --chart-3: #1d5fbf;')
    expect(sheet).toContain('  --pill-positive-bg: #dcfae5;')
    expect(sheet).toContain('  --radius-card: 8px;')
    expect(sheet).toContain('  --fs-kpi: 30px;')
    expect(sheet).toContain('font-family: "Geist", system-ui, sans-serif.')
    expect(sheet).toContain('4. Shell: Open plane (open-plane)')
    expect(sheet).toContain("- overview: KPIs as the chart's tabs (kpi-tabs-chart).")
    expect(sheet).toContain('- list: no pattern in the library suits this kind of product')
    expect(sheet).not.toMatch(/node <skill>|draw\.mjs|fonts\.googleapis|Inter, system-ui/u)
    expect(appDirectionTypefaces(direction)).toEqual(['Geist', 'Geist Mono'])
    expect(appDirectionTokens(direction)['--control-height']).toBe('36px')
  })

  it('quotes chapter sections verbatim, once each and in document order', () => {
    const chapter = readFileSync(new URL('app-screens.md', library), 'utf8')
    const rules = appScreenRules(['14', '13', '13'])
    expect(rules).toContain('lint.mjs')
    const body = /<tasteskill-app-screen-rules>\n([\s\S]*)\n<\/tasteskill-app-screen-rules>/u.exec(
      rules,
    )![1]!
    expect(chapter).toContain(body)
    expect(body.indexOf('## 13. House rules')).toBeLessThan(body.indexOf('## 14. Tells'))
    expect(body.split('## 13. House rules')).toHaveLength(2)
    const nested = appScreenRules(['6', '6.4'])
    expect(nested.split('### 6.4 Marks')).toHaveLength(2)
    expect(appScreenRules(['intro'])).toContain('Colour goes on data, not chrome.')
    expect(() => appScreenRules(['15'])).toThrow('no section 15')
  })

  it('writes the kit into the workspace with the license line on every copy', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'taste-app-kit-'))
    roots.push(workspace)
    writeAppScreenKit(workspace)
    writeAppScreenKit(workspace)
    const kit = path.join(workspace, '.taste', 'app-kit')
    expect(readdirSync(kit).sort()).toEqual(['LICENSE', 'app-screens.md', 'app.css', 'charts.js'])
    for (const file of ['app.css', 'charts.js']) {
      const [header, ...rest] = readFileSync(path.join(kit, file), 'utf8').split('\n')
      expect(header).toBe(
        `/* tasteskill v2.1.5 ${file} (MIT License, Copyright (c) 2026 Leonxlnx): https://github.com/Leonxlnx/taste-skill. Keep this line in every copy. */`,
      )
      expect(rest.join('\n')).toBe(readFileSync(new URL(file, library), 'utf8'))
    }
  })
})
