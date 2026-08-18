import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const pullRequestCss = readFileSync(
  new URL('../ui/pull-requests/pull-requests.css', import.meta.url),
  'utf8',
)
const workspaceCss = readFileSync(new URL('../ui/workspace-panel.css', import.meta.url), 'utf8')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('send control motion', () => {
  it('uses the same shallow press on main send, stop, PR send, and side-chat send', () => {
    expect(rule(appCss, '.orb:active:not(:disabled):not(.orb--stop)')).toContain(
      'transform: scale(0.97)',
    )
    expect(rule(appCss, '.orb--stop:active:not(:disabled)')).toContain('transform: scale(0.97)')
    expect(rule(pullRequestCss, '.pr-send-button:active:not(:disabled)')).toContain(
      'transform: scale(0.97)',
    )
    expect(
      rule(workspaceCss, '.workspace-side-chat__composer button:active:not(:disabled)'),
    ).toContain('transform: scale(0.97)')
  })

  it('keeps the main send active rule after hover so press wins the cascade', () => {
    const hoverRule = appCss.indexOf('\n  .orb:hover:not(:disabled):not(.orb--stop) {')
    const activeRule = appCss.indexOf('\n.orb:active:not(:disabled):not(.orb--stop) {')

    expect(hoverRule).toBeGreaterThan(-1)
    expect(activeRule).toBeGreaterThan(hoverRule)
  })

  it('keeps hover scale behind precise-pointer media queries', () => {
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.orb:hover:not\(:disabled\):not\(\.orb--stop\) \{/s,
    )
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.orb--stop:hover:not\(:disabled\) \{/s,
    )
    expect(pullRequestCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.pr-send-button:hover:not\(:disabled\) \{/s,
    )
    expect(workspaceCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.workspace-side-chat__composer button:not\(:disabled\):hover \{/s,
    )
  })

  it('removes send and stop scale under reduced motion', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.orb:hover:not\(:disabled\):not\(\.orb--stop\),[\s\S]*?\.orb--stop:hover:not\(:disabled\),[\s\S]*?\.orb:active:not\(:disabled\):not\(\.orb--stop\),[\s\S]*?\.orb--stop:active:not\(:disabled\) \{[\s\S]*?transform: none !important;/s,
    )
    expect(pullRequestCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pr-send-button:hover:not\(:disabled\),[\s\S]*?\.pr-send-button:active:not\(:disabled\) \{[\s\S]*?transform: none !important;/s,
    )
    expect(workspaceCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.workspace-side-chat__composer button:not\(:disabled\):hover,[\s\S]*?\.workspace-side-chat__composer button:active:not\(:disabled\) \{[\s\S]*?transform: none !important;/s,
    )
  })
})
