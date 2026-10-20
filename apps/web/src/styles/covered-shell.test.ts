import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SOURCE = fileURLToPath(new URL('..', import.meta.url))
const COVERED = '.shell__body[data-covered] '

/**
 * Endless animations that never render inside .shell__body, so the covered
 * mark cannot reach them: Settings itself, onboarding, and the overlays App
 * draws after the shell or portals to the document body.
 */
const OUTSIDE_SHELL = {
  '.gwin__term-line[data-cursor]': 'Settings > General',
  ".keybind-row[data-recording]:not([data-tone='error']) .set-leader": 'Settings > Keybinds',
  '.keybind-shortcut__caret::before': 'Settings > Keybinds',
  '.profile-activity.is-refreshing .profile-activity__refresh svg': 'Settings > Profile',
  ".settings .set-notice[data-tone='progress'] .set-notice__icon": 'Settings',
  '.settings .provider-row[data-live] > .set-leader': 'Settings > Providers',
  '.settings .usage-page__refresh.is-busy svg': 'Settings > Usage',
  '.provider-update-spinner': 'Settings > Providers (update check)',
  '.preview:not([data-still]) .preview__activity-icon > .preview__spinner': 'onboarding preview',
  '.preview:not([data-still]) .preview__caret': 'onboarding preview',
  '.rollback__cut.is-loading .rollback__dots': 'rollback dialog',
  '.session-search__spinner': 'session search',
  ".version-reel[data-turn='turning'] .version-reel__strip": 'provider update notice',
  '.media-viewer__video-loading': 'media viewer (portal to the body)',
} satisfies Record<string, string>
const outsideShell = new Set<string>(Object.keys(OUTSIDE_SHELL))

interface Rule {
  file: string
  selectors: string[]
  body: string
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

/** Splits on commas outside parentheses: selector lists and animation lists. */
function splitList(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/** Every innermost rule of a stylesheet, at-rule wrappers included. */
function rulesOf(file: string): Rule[] {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const open: { prelude: string; at: number }[] = []
  let start = 0
  for (let index = 0; index < css.length; index++) {
    const char = css[index]
    if (char === '{') {
      open.push({ prelude: css.slice(start, index), at: index })
      start = index + 1
    } else if (char === '}') {
      const block = open.pop()
      const body = block ? css.slice(block.at + 1, index) : ''
      if (block && !body.includes('{')) {
        rules.push({ file: relative(SOURCE, file), selectors: splitList(block.prelude), body })
      }
      start = index + 1
    } else if (char === ';' && open.length === 0) {
      start = index + 1
    }
  }
  return rules
}

function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[;{\\s])${property}\\s*:([^;]*)`).exec(body)?.[1]
}

const rules = cssFiles(SOURCE).flatMap(rulesOf)
const loops = rules.flatMap((rule) => {
  const animation = declaration(rule.body, 'animation')
  const items = animation ? splitList(animation) : []
  if (!items.some((item) => /\binfinite\b/.test(item))) return []
  // Only the endless items pause; a one-shot one beside them keeps running.
  const playState = items.map((item) => (/\binfinite\b/.test(item) ? 'paused' : 'running'))
  return rule.selectors.map((selector) => ({ file: rule.file, selector, playState }))
})
const paused = new Map(
  rules
    .filter((rule) => rule.selectors.every((selector) => selector.startsWith(COVERED)))
    .flatMap((rule) => {
      const playState = declaration(rule.body, 'animation-play-state')
      if (!playState) return []
      const items = splitList(playState.replace(/!important/, ''))
      return rule.selectors.map((selector) => [selector.slice(COVERED.length), items] as const)
    }),
)

describe('the shell behind Settings', () => {
  it('pauses every endless animation that can render inside the shell', () => {
    expect(loops.length).toBeGreaterThan(20)
    for (const loop of loops) {
      if (outsideShell.has(loop.selector)) continue
      const label = `${loop.file}: ${loop.selector}`
      expect(paused.has(loop.selector), `${label} loops but keeps running behind Settings`).toBe(
        true,
      )
      const state = paused.get(loop.selector)
      const all = loop.playState.every((item) => item === 'paused')
      expect(state, label).toEqual(all ? ['paused'] : loop.playState)
    }
  })

  it('leaves one-shot animations playing behind Settings', () => {
    const looping = new Set(loops.map((loop) => loop.selector))
    for (const selector of paused.keys()) {
      expect(looping.has(selector), `${selector} is paused but does not loop`).toBe(true)
      expect(selector).not.toMatch(/(^|\s)\*/)
    }
  })

  it('names only endless animations that still exist outside the shell', () => {
    const looping = new Set(loops.map((loop) => loop.selector))
    for (const selector of outsideShell) {
      expect(looping.has(selector), `${selector} no longer loops`).toBe(true)
      expect(paused.has(selector), `${selector} is paused and listed as outside`).toBe(false)
    }
  })
})
