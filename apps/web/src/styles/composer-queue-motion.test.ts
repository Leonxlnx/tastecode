import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../ui/Composer.tsx', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    appCss.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ??
    ''
  )
}

describe('composer queue motion', () => {
  it('reveals the panel from the composer edge and keeps row motion compositor-safe', () => {
    const panel = rule('.composer__queue')
    const row = rule('.queue-row')

    expect(panel).toContain(
      'animation: composer-queue-panel-in var(--dur-slow) var(--ease-rail) both;',
    )
    expect(appCss).toMatch(
      /@keyframes composer-queue-panel-in \{[\s\S]*?clip-path: inset\(100% 0 0\);[\s\S]*?opacity: 0;[\s\S]*?clip-path: inset\(0 0 0\);[\s\S]*?opacity: 1;/,
    )
    // A resting will-change would keep queued text off subpixel antialiasing.
    expect(row).not.toContain('will-change')
    expect(row).toContain('opacity var(--dur-fast) var(--ease-out)')
    expect(row).toContain('transform var(--dur-press) var(--ease-out)')
    expect(appCss).toMatch(
      // The panel grows on --ease-rail; the new row fades in on the same curve
      // so it is readable while the space opens, not after.
      /\.queue-row\[data-queue-phase='entering'\] \{[\s\S]*?composer-queue-item-in var\(--dur-slow\) var\(--ease-rail\)/,
    )
    expect(appCss).toMatch(
      /\.queue-row\[data-queue-phase='exiting'\] \{[\s\S]*?composer-queue-item-out var\(--dur-fast\) var\(--ease-out\)/,
    )
    expect(appCss).toContain(".queue-row[data-queue-phase='exiting'][data-queue-positioned]")
    expect(appCss).toContain(
      '@keyframes composer-queue-item-in {\n  from {\n    opacity: 0;\n  }\n}',
    )
    expect(appCss).toContain(
      '@keyframes composer-queue-item-out {\n  to {\n    opacity: 0;\n  }\n}',
    )
  })

  it('keeps the composer box off its own layer at rest, so its labels stay crisp', () => {
    // Chromium draws text in a will-change: transform layer without subpixel
    // antialiasing; the dock FLIP promotes the box only while it runs.
    expect(rule('.composer__box')).not.toContain('will-change')
    expect(composerSource).toContain("{ transform: 'translate3d(0, 0, 0)' }")
  })

  it('spans the whole composer and tucks only behind its rounded top', () => {
    const panel = rule('.composer__queue')

    expect(panel).toContain('right: 0;')
    expect(panel).toContain('left: 0;')
    // Tucking exactly the corner radius lets the panel's sides run straight
    // into the prompt's sides; a shallower tuck leaves a notch at each corner.
    expect(panel).toContain('bottom: calc(100% - var(--r-composer));')
    // That band is covered, so the bottom padding has to clear it or the last
    // row's lower edge disappears behind the prompt.
    expect(panel).toMatch(/padding: \d+px \d+px calc\(var\(--r-composer\) \+ \d+px\);/)
  })

  it('lets a queued row grow with its text instead of clipping it', () => {
    const row = rule('.queue-row')
    const text = rule('.queue-row__text')
    const steer = rule('.queue-row__steer')

    expect(row).toMatch(/min-height: \d+px;/)
    expect(row).not.toMatch(/(^|[\s;])height:/m)
    expect(text).not.toMatch(/(^|[\s;])(max-)?height:/m)
    // overflow: hidden (for the ellipsis) clips at the line box, so the line
    // has to hold the font's whole ascent and descent: Segoe UI's runs to
    // about 1.33em, which line-height 1.1 cut off at the top and bottom.
    expect(text).toContain('overflow: hidden;')
    expect(Number(/line-height: ([\d.]+);/.exec(text)?.[1])).toBeGreaterThanOrEqual(1.4)
    expect(text).toContain('font-size: var(--t-md);')
    expect(steer).toContain('font-size: var(--t-sm);')
  })

  it('keeps every queued row control on one height', () => {
    const row = rule('.queue-row')
    const media = rule('.queue-row__media')
    const handle = rule('.queue-row__handle')
    const steer = rule('.queue-row__steer')

    expect(row).toContain('min-height: 30px;')
    expect(row).toContain('padding: 2px 0;')
    expect(handle).toContain('width: 20px;')
    expect(handle).toContain('height: 26px;')
    expect(media).toContain('width: 24px;')
    expect(media).toContain('height: 24px;')
    expect(steer).toContain('gap: 5px;')
    expect(steer).toContain('padding: 0 8px;')
    expect(appCss).toMatch(/\.queue-row__steer,\n\.queue-row__action \{[^}]*?\n {2}height: 26px;/)
    expect(appCss).toMatch(/\.queue-row__action \{[\s\S]*?width: 26px;[\s\S]*?padding: 0;/)
    expect(appCss).toMatch(
      /\.queue-row > \.menuwrap \.queue-row__action \{[\s\S]*?width: 26px;[\s\S]*?height: 26px;/,
    )
    expect(composerSource).toContain('<GripVertical size={14} aria-hidden />')
    expect(composerSource).toContain('<CornerDownRight size={13} aria-hidden />')
    expect(composerSource).toContain('<Pencil size={14} aria-hidden />')
    expect(composerSource).toContain('<Trash2 size={14} aria-hidden />')
    expect(composerSource).toContain('<Video size={12} /> : <ImageIcon size={12} />')
    expect(composerSource).toContain('<Play size={7} fill="currentColor" />')
  })

  it('draws the reorder drop line in a defined token', () => {
    // --accent is defined nowhere, so the line it painted was invisible. The
    // sidebar's project drop line had the same bug and was fixed with --light.
    const dropLine = rule('.queue-row[data-drop-position]::before')

    expect(dropLine).toContain('background: var(--light);')
    expect(tokensCss).toMatch(/^\s*--light: /m)
  })

  it('keeps only finite opacity feedback when reduced motion is requested', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.composer__queue \{[\s\S]*?animation: fade-in[\s\S]*?\.queue-row\[data-queue-phase='entering'\] \{[\s\S]*?composer-queue-item-fade-in[\s\S]*?\.queue-row\[data-queue-phase='exiting'\] \{[\s\S]*?composer-queue-item-fade-out[\s\S]*?\.queue-row\.is-dragging \{[\s\S]*?transform: none;/s,
    )
  })
})
