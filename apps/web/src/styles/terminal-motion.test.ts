import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    appCss.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ??
    ''
  )
}

describe('terminal motion', () => {
  it('defines the shared view-transition token and names', () => {
    expect(tokensCss).toContain('--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);')
    expect(appCss).toContain('.stage__body > .thread-shell')
    expect(appCss).toContain('view-transition-name: terminal-thread;')
    expect(appCss).toContain('view-transition-name: terminal-pane;')
    expect(appCss).toContain('view-transition-name: terminal-composer;')
    expect(appCss).toContain('animation-duration: var(--dur-slow);')
    expect(appCss).toContain('animation-timing-function: var(--ease-in-out);')
  })

  it('slides the terminal snapshot by its own full height and removes old entry keyframes', () => {
    expect(appCss).toContain('animation: terminal-view-in var(--dur-slow) var(--ease-out) both;')
    expect(appCss).toContain('animation: terminal-view-out var(--dur-slow) var(--ease-out) both;')
    expect(appCss).toMatch(/@keyframes terminal-view-in \{[\s\S]*?translateY\(100%\);/s)
    expect(appCss).toMatch(/@keyframes terminal-view-out \{[\s\S]*?translateY\(100%\);/s)
    expect(appCss).not.toContain('terminal-in')
  })

  it('disables the snapshot names under reduced motion and avoids layout-property animation', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.stage__body > \.thread-shell,[\s\S]*?\.stage__body > \.terminal-pane,[\s\S]*?\.stage__body > \.composer \{[\s\S]*?view-transition-name: none;/s,
    )

    expect(rule('.stage__body')).not.toContain('transition:')
    expect(rule('.stage__body.has-terminal')).not.toContain('transition:')
    expect(rule('.terminal-pane')).not.toContain('transition:')
    expect(
      rule(
        '::view-transition-group(terminal-thread),\n::view-transition-group(terminal-pane),\n::view-transition-group(terminal-composer)',
      ),
    ).not.toContain('transition:')
    expect(rule('::view-transition-new(terminal-pane)')).not.toContain('transition:')
    expect(rule('::view-transition-old(terminal-pane)')).not.toContain('transition:')
  })
})
