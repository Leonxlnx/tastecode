import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const terminalCss = readFileSync(new URL('./terminal-pane.css', import.meta.url), 'utf8')

function rule(selector: string, css = appCss): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('bottom terminal visual stability', () => {
  it('does not snapshot the terminal, thread, or composer', () => {
    expect(appCss).not.toContain('view-transition-name: terminal-')
    expect(appCss).not.toContain('terminal-view-in')
    expect(appCss).not.toContain('terminal-view-out')
  })

  it('keeps xterm from exposing its black viewport strip', () => {
    const viewport = rule('.terminal-pane__viewport .xterm .xterm-viewport', terminalCss)

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
    expect(terminalCss).not.toContain('.terminal-pane__viewport:focus-within')
    expect(rule('.stage__body')).not.toContain('transition:')
    expect(rule('.stage__body.has-terminal')).not.toContain('transition:')
    expect(rule('.terminal-pane', terminalCss)).not.toContain('transition:')
  })

  it('keeps the new-session heading and composer fixed when the terminal opens', () => {
    const newSession = rule('.stage__body.is-new-session')
    const withTerminal = rule('.stage__body.is-new-session.has-terminal')
    const conversation = rule('.stage__conversation.is-new-session')
    const terminal = rule('.stage__body.is-new-session > .bottom-terminal')

    expect(newSession).toContain('grid-template-rows: auto;')
    expect(newSession).toContain('clamp(0px, calc(648px - 100vh), 188px)')
    expect(withTerminal).toContain('grid-template-rows: auto;')
    expect(conversation).toContain('grid-template-rows: auto auto;')
    expect(terminal).toContain('position: absolute;')
    expect(terminal).toContain('bottom: 0;')
    expect(terminal).toContain('max-height: max(160px, calc(50% - 124px));')
    expect(rule('.stage__body.is-new-session > .bottom-terminal > .terminal-pane')).toContain(
      'max-height: 100%;',
    )
  })

  it('removes positional motion when reduced motion is requested', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.bottom-terminal \{[\s\S]*?transform: none;[\s\S]*?transition: none;/,
    )
  })
})
