import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  tasteskillSection,
  tasteskillWebsiteRules,
  WEBSITE_RULE_SECTIONS,
  type WebsitePhase,
} from './tasteskill-web.js'

const library = new URL('../references/tasteskill-web/', import.meta.url)

describe('tasteskill website chapters', () => {
  it('are unmodified copies of the pinned v2.5.0 release', () => {
    const provenance = JSON.parse(readFileSync(new URL('provenance.json', library), 'utf8')) as {
      source: { ref: string; commit: string; license: string }
      files: { path: string; sha256: string }[]
    }
    expect(provenance.source).toMatchObject({
      ref: 'v2.5.0',
      commit: '822e0b9d872e10deb931afad2c6c2bd943cf4c7b',
      license: 'MIT',
    })
    for (const file of provenance.files) {
      const sha256 = createHash('sha256')
        .update(readFileSync(new URL(file.path, library)))
        .digest('hex')
      expect(sha256, file.path).toBe(file.sha256)
    }
  })

  it('still hold every section a phase quotes', () => {
    for (const sections of Object.values(WEBSITE_RULE_SECTIONS))
      for (const [file, heading] of sections)
        expect(tasteskillSection(file, heading), `${file} ${heading}`).toMatch(/^## /)
  })

  it('quotes one section whole, up to the next one, with or without its number', () => {
    const screens = tasteskillSection('layout-v4.md', 'One section per screen')
    expect(screens).toBe(tasteskillSection('layout-v4.md', '2. One section per screen'))
    expect(screens.startsWith('## 2. One section per screen')).toBe(true)
    expect(screens).toContain('**The judge tile.**')
    expect(screens).not.toContain('## 3. The hero')
    expect(() => tasteskillSection('copy.md', 'No such section')).toThrow(/no section/)
  })

  it('puts the TasteCode adaptations in front of the quoted rules', () => {
    for (const phase of Object.keys(WEBSITE_RULE_SECTIONS) as WebsitePhase[]) {
      const rules = tasteskillWebsiteRules(phase)
      expect(rules.indexOf('TasteCode adaptations')).toBeLessThan(
        rules.indexOf('<tasteskill-rules>'),
      )
      expect(rules).toContain(
        'No picture library. There are no stock, library, template or sample pictures.',
      )
      expect(rules).toContain('The selected references decide each section')
    }
    const page = tasteskillWebsiteRules('page')
    expect(page).toContain('## House rules')
    expect(page).toContain('## Five rules')
    expect(page).toContain('## 4. Equal edges and the grid')
    expect(tasteskillWebsiteRules('review')).toContain('## 5. Checklist')
  })
})
