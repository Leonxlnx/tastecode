import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

describe('menu interaction CSS', () => {
  it('animates pointer openings from both anchor axes and removes reduced motion', () => {
    expect(appCss).toMatch(
      /\.menu\.is-positioned\[data-input-modality='pointer'\] \{[^}]*animation: menu-in/s,
    )
    expect(appCss).toMatch(
      /\.menu\[data-origin-x='right'\]\[data-origin-y='bottom'\] \{[^}]*transform-origin: right bottom/s,
    )
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.menu\.is-positioned\[data-input-modality='pointer'\] \{[^}]*animation: none/s,
    )
  })
})
