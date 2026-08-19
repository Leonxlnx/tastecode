import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    appCss.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ??
    ''
  )
}

describe('bottom terminal visual stability', () => {
  it('does not snapshot the terminal, thread, or composer', () => {
    expect(appCss).not.toContain('view-transition-name: terminal-')
    expect(appCss).not.toContain('terminal-view-in')
    expect(appCss).not.toContain('terminal-view-out')
  })

  it('keeps xterm from exposing its black viewport strip', () => {
    const viewport = rule('.terminal-pane__viewport .xterm .xterm-viewport')

    expect(viewport).toContain('overflow-x: hidden;')
    expect(viewport).toContain('background-color: transparent;')
  })

  it('slides the live terminal with a short transform-only transition', () => {
    const terminal = rule('.bottom-terminal')
    const open = rule('.bottom-terminal.is-open')
    const closing = rule('.bottom-terminal.is-closing')
    const parked = rule('.bottom-terminal.is-parked')

    expect(terminal).toContain('contain: layout paint;')
    expect(terminal).toContain('transform: translate3d(0, 100%, 0);')
    expect(terminal).toContain('transition: transform var(--dur-slow) var(--ease-rail);')
    expect(open).toContain('transform: translate3d(0, 0, 0);')
    expect(closing).toContain('position: absolute;')
    expect(closing).toContain('bottom: 0;')
    expect(parked).toContain('visibility: hidden;')
    expect(parked).toContain('pointer-events: none;')
    expect(terminal).not.toMatch(/transition:[^;]*(height|grid-template-rows)/)
    expect(appCss).toMatch(
      /@starting-style \{[\s\S]*?\.bottom-terminal\.is-open \{[\s\S]*?transform: translate3d\(0, 100%, 0\);/,
    )
  })

  it('avoids the stray focus rail and layout-property animation', () => {
    expect(appCss).not.toContain('.terminal-pane__viewport:focus-within')
    expect(rule('.stage__body')).not.toContain('transition:')
    expect(rule('.stage__body.has-terminal')).not.toContain('transition:')
    expect(rule('.terminal-pane')).not.toContain('transition:')
  })

  it('removes positional motion when reduced motion is requested', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.bottom-terminal \{[\s\S]*?transform: none;[\s\S]*?transition: none;/,
    )
  })
})
