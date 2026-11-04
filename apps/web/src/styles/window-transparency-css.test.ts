import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/*
 * The desktop window shows the OS material (Windows 11 acrylic or Mica, macOS
 * vibrancy) only where every layer of the page above it is transparent. These
 * tests read the stylesheets as text, the way app-background-css.test.ts does,
 * and check the cascade by specificity, so a new opaque rule on one of these
 * elements fails here instead of quietly turning the window solid again.
 */

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

type Rule = { selectors: string[]; body: string }

function rules(sheet: string): Rule[] {
  const css = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: splitSelectors(match[1] ?? ''),
    body: match[2] ?? '',
  }))
}

/** Commas outside brackets and parentheses separate selectors. */
function splitSelectors(list: string): string[] {
  const selectors: string[] = []
  let depth = 0
  let current = ''
  for (const char of list) {
    if (char === '(' || char === '[') depth++
    if (char === ')' || char === ']') depth--
    if (char === ',' && depth === 0) {
      selectors.push(current)
      current = ''
    } else {
      current += char
    }
  }
  selectors.push(current)
  return selectors.map((selector) => selector.replace(/\s+/g, ' ').trim())
}

/** The compound after the last combinator: the element the rule paints. */
function subject(selector: string): string {
  let depth = 0
  let start = 0
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index] ?? ''
    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (depth === 0 && /[\s>+~]/.test(char)) start = index + 1
  }
  return selector.slice(start)
}

/** [ids, classes + attributes + pseudo-classes, types]; :not() counts its argument. */
function specificity(selector: string): [number, number, number] {
  let rest = selector.replace(/:where\([^)]*\)/g, '').replace(/:not\(([^)]*)\)/g, ' $1')
  const attributes = rest.match(/\[[^\]]*\]/g)?.length ?? 0
  rest = rest.replace(/\[[^\]]*\]/g, '')
  const ids = rest.match(/#[\w-]+/g)?.length ?? 0
  const classes = rest.match(/\.[\w-]+/g)?.length ?? 0
  const pseudoClasses = rest.match(/(?<!:):(?!:)[\w-]+/g)?.length ?? 0
  const types = rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0
  return [ids, attributes + classes + pseudoClasses, types]
}

function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return true
}

/** The background a rule declares, or undefined. Custom properties are not backgrounds. */
function background(body: string): string | undefined {
  return /(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/.exec(body)?.[1]?.trim()
}

const clear = (value: string | undefined) => value === 'transparent' || value === 'none'

const tokens = read('./tokens.css')
const app = read('./app.css')
const windowBackground = read('./app-background.css')
const eager = [...rules(tokens), ...rules(app)]

function matches(selector: string, target: string): boolean {
  const compound = subject(selector)
  // ::before and ::after paint a box of their own, not the element.
  if (compound.includes('::')) return false
  return target.startsWith('.')
    ? new RegExp(`\\${target}(?![\\w-])`).test(compound)
    : new RegExp(`^${target}(?![\\w-])`).test(compound)
}

/** Every eager rule that paints `target` (a type or a class) with something. */
function opaqueRulesFor(target: string): string[] {
  return eager.flatMap((rule) =>
    clear(background(rule.body)) || background(rule.body) === undefined
      ? []
      : rule.selectors.filter((selector) => matches(selector, target)),
  )
}

/** The selector in `sheet` that clears `target`, by its exact text. */
function clearingSelector(sheet: Rule[], selector: string): string {
  const rule = sheet.find((candidate) => candidate.selectors.includes(selector))
  expect(rule, selector).toBeDefined()
  expect(background(rule?.body ?? ''), selector).toBe('transparent')
  return selector
}

describe('window transparency CSS', () => {
  it('never paints the root element, which would fill the whole window', () => {
    // A root background covers the canvas whatever body does, so the window
    // could never show the material behind it.
    const sheets = readdirSync(new URL('./', import.meta.url)).filter((name) =>
      name.endsWith('.css'),
    )
    expect(sheets).toContain('tokens.css')
    for (const name of sheets) {
      for (const rule of rules(read(`./${name}`))) {
        for (const selector of rule.selectors) {
          if (!/^(?:html|:root)(?:\[[^\]]*\]|:not\([^)]*\)|\.[\w-]+)*$/.test(selector)) continue
          expect(background(rule.body), `${name}: ${selector}`).toBeUndefined()
        }
      }
    }
  })

  describe('with Window background › Transparent', () => {
    const sheet = rules(windowBackground)
    const prefix = ':root[data-app-bg][data-theme][data-shell][data-glass]'
    const cleared = [
      ['body', `${prefix} body`],
      ['.shell__body', `${prefix} .shell__body`],
      ['.workspace-layout', `${prefix} .shell__body > .workspace-layout`],
      ['.stagehead', `${prefix} .stagehead`],
    ] as const

    it.each(cleared)('clears %s above every rule that paints it', (target, selector) => {
      const winner = specificity(clearingSelector(sheet, selector))
      const opaque = opaqueRulesFor(target)
      if (target === '.workspace-layout') {
        // The dark sidebar glass paints every column but the rail with --bg.
        const columns = eager
          .flatMap((rule) => rule.selectors)
          .filter((candidate) => candidate.endsWith('.shell__body > :not(.rail-slot)'))
        expect(columns).toHaveLength(1)
        opaque.push(...columns)
      }
      expect(opaque.length).toBeGreaterThan(0)
      for (const competitor of opaque) {
        // Ties go to app-background.css, which loads after app.css.
        expect(atLeast(winner, specificity(competitor)), `${selector} vs ${competitor}`).toBe(true)
      }
    })

    it('keeps the chat pane and sidebar tinted, so text stays readable', () => {
      const stage = sheet.find((rule) => rule.selectors.includes(`${prefix} .stage`))
      expect(background(stage?.body ?? '')).toBe(
        'color-mix(in srgb, var(--bg) var(--app-bg-stage), transparent)',
      )
      expect(windowBackground).toMatch(/--app-bg-stage: \d+%;/)
      const rail = sheet.find((rule) =>
        rule.selectors.includes(`${prefix} .rail-slot:not(.is-collapsed) .rail`),
      )
      expect(background(rail?.body ?? '')).toBe('var(--app-bg-rail-pane)')
      expect(windowBackground).toMatch(
        /--app-bg-rail-pane: color-mix\(\s*in srgb,\s*var\(--bg-rail-tint\)/,
      )
    })

    it('paints no layer of its own, so the OS material is the background', () => {
      const layer = read('../ui/AppBackgroundLayer.tsx')
      expect(layer).toContain("if (mode === 'transparent' || mode === 'none') return null")
    })
  })

  describe('with sidebar glass on in the dark desktop window', () => {
    const glass = ":root[data-glass='on'][data-shell='desktop']:not([data-theme='light'])"

    it.each([
      ['body', `${glass} body`],
      ['.shell__body', `${glass} .shell__body`],
    ] as const)('clears %s above every rule that paints it', (target, selector) => {
      const winner = specificity(clearingSelector(rules(app), selector))
      for (const competitor of opaqueRulesFor(target)) {
        if (competitor.includes("[data-theme='light']")) continue
        expect(atLeast(winner, specificity(competitor)), `${selector} vs ${competitor}`).toBe(true)
      }
    })
  })

  it('counts specificity the way the cascade does', () => {
    expect(specificity('body')).toEqual([0, 0, 1])
    expect(specificity('.shell__body > :not(.rail-slot)')).toEqual([0, 2, 0])
    expect(specificity(`${':root[data-app-bg][data-theme]'} .stagehead`)).toEqual([0, 4, 0])
    expect(specificity(':where(.a, .b) .c')).toEqual([0, 1, 0])
    expect(subject(':root[data-x] .shell__body > .workspace-layout')).toBe('.workspace-layout')
  })
})
