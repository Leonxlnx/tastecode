import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./pull-requests.css', import.meta.url), 'utf8')

describe('pull request layout CSS', () => {
  it('skips layout and paint for off-screen pull-request rows', () => {
    expect(css).toMatch(
      /\.pr-list-item \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-size: auto 59px;/s,
    )
  })

  it('keeps the right-side summary compact and leaves metadata on a flat surface', () => {
    expect(css).toMatch(
      /\.pr-summary \{[^}]*width: min\(100%, 900px\);[^}]*padding: 12px 22px 88px;/s,
    )
    expect(css).toMatch(/\.pr-facts \{[^}]*display: grid;[^}]*padding: 5px 0 3px;/s)
    expect(css.match(/\.pr-facts \{([^}]*)\}/s)?.[1]).not.toContain('background')
    expect(css.match(/\.pr-facts \{([^}]*)\}/s)?.[1]).not.toContain('border')
  })

  it('does not add a second padded control around toolbar menus', () => {
    expect(css).toMatch(/\.pr-toolbar-menu-trigger \{[^}]*padding: 0;/s)
  })

  it('uses the regular prompt-bar surface without a formatting toolbar', () => {
    expect(css).toMatch(
      /\.pr-composer \{[^}]*padding: 0;[^}]*overflow: hidden;[^}]*background: var\(--bg-prompt\);[^}]*box-shadow: var\(--composer-shadow\);/s,
    )
    expect(css).toMatch(
      /\.pr-composer textarea \{[^}]*width: 100%;[^}]*min-height: 62px;[^}]*max-height: 160px;[^}]*resize: none;[^}]*background: none;[^}]*border: 0;/s,
    )
    expect(css).not.toContain('.pr-composer-format')
  })

  it('keeps title and description editing on the existing text surface', () => {
    expect(css).toMatch(
      /\.pr-title-editor \{[^}]*padding: 0;[^}]*background: transparent;[^}]*border: 0;[^}]*box-shadow: none;/s,
    )
    expect(css).toMatch(
      /\.pr-description-editor \{[^}]*padding: 0;[^}]*resize: none;[^}]*background: transparent;[^}]*border: 0;[^}]*box-shadow: none;/s,
    )
    expect(css).not.toContain('.pr-inline-edit-actions')
  })

  it('sizes metadata pickers like the compact reference popup', () => {
    expect(css).toMatch(/\.pr-metadata-menu \{[^}]*width: min\(310px, calc\(100vw - 16px\)\);/s)
    expect(css).toMatch(/\.pr-picker-search \{[^}]*min-height: 34px;/s)
  })

  it('lets the status menu inherit shared popup geometry without a conflicting override', () => {
    expect(css).toMatch(/\.pr-status-menu \{[^}]*min-width: min\(170px, calc\(100vw - 16px\)\);/s)
    expect(css).not.toContain('.pr-status-menu .menu__item')
  })

  it('keeps metadata values on one line inside a compact app-style trigger', () => {
    expect(css).toMatch(/\.pr-fact-menu-value \{[^}]*white-space: nowrap;/s)
    expect(css).toMatch(/\.pr-fact-menu-trigger \{[^}]*border-radius: var\(--r-lg\);/s)
  })

  it('keeps avatar stacks out of the truncating text path', () => {
    expect(css).toMatch(
      /\.pr-fact-menu-trigger\.is-shape-preserving \{[^}]*width: max-content;[^}]*min-width: max-content;[^}]*overflow: visible;/s,
    )
    expect(css).toMatch(
      /\.pr-fact-menu-trigger\.is-shape-preserving \.pr-fact-menu-value > span:first-child \{[^}]*overflow: visible;[^}]*text-overflow: clip;/s,
    )
    expect(css).toMatch(/\.pr-actor-stack \{[^}]*min-width: max-content;[^}]*flex: none;/s)
  })

  it('gives activity comments a GitHub-style avatar timeline and split comment surface', () => {
    expect(css).toMatch(
      /\.pr-timeline-list \{[^}]*position: relative;[^}]*display: grid;[^}]*gap: 16px;/s,
    )
    expect(css).toMatch(
      /\.pr-timeline-list::before \{[^}]*left: 15px;[^}]*width: 2px;[^}]*background: var\(--line\);/s,
    )
    expect(css).toMatch(
      /\.pr-activity-card,[^{]*\.pr-review-event \{[^}]*grid-template-columns: 32px minmax\(0, 1fr\);[^}]*gap: 12px;/s,
    )
    expect(css).toMatch(
      /\.pr-activity-comment > header \{[^}]*min-height: 40px;[^}]*background: var\(--pr-comment-header\);[^}]*border-bottom: 1px solid var\(--line\);/s,
    )
    expect(css).toMatch(
      /\.pr-activity-comment-body \{[^}]*min-height: 58px;[^}]*padding: 14px 16px 16px;/s,
    )
  })
})
