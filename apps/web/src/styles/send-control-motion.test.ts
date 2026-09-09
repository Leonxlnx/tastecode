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
    css.match(new RegExp(`^[\\t ]*${escaped} \\{(?<body>[\\s\\S]*?)\\n[\\t ]*\\}`, 'm'))?.groups?.[
      'body'
    ] ?? ''
  )
}

describe('send control motion', () => {
  it('keeps main send, stop, PR send, and side-chat send still when pressed', () => {
    expect(rule(appCss, '.orb:active:not(:disabled):not(.orb--stop)')).toBe('')
    expect(rule(appCss, '.orb--stop:active:not(:disabled)')).toBe('')
    expect(rule(pullRequestCss, '.pr-send-button:active:not(:disabled)')).toBe('')
    expect(rule(workspaceCss, '.workspace-side-chat__composer button:active:not(:disabled)')).toBe(
      '',
    )
  })

  it('keeps send and stop geometry still on hover', () => {
    expect(rule(appCss, '.orb:hover:not(:disabled):not(.orb--stop)').trim()).not.toContain(
      'transform:',
    )
    expect(rule(appCss, '.orb--stop:hover:not(:disabled)').trim()).not.toContain('transform:')
    expect(
      rule(
        pullRequestCss,
        '.pr-send-button:hover:not(:disabled):not(.is-approve):not(.is-request_changes)',
      ).trim(),
    ).not.toContain('transform:')
    expect(
      rule(workspaceCss, '.workspace-side-chat__composer button:not(:disabled):hover'),
    ).not.toMatch(/\b(?:scale|translate|rotate)\(/)
  })

  it('keeps pointer hover colors behind precise-pointer media queries', () => {
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.orb:hover:not\(:disabled\):not\(\.orb--stop\) \{/s,
    )
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.orb--stop:hover:not\(:disabled\) \{/s,
    )
    expect(pullRequestCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.pr-send-button:hover:not\(:disabled\):not\(\.is-approve\):not\(\.is-request_changes\) \{/s,
    )
  })

  it('removes send and stop scale under reduced motion', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.orb:hover:not\(:disabled\):not\(\.orb--stop\),[\s\S]*?\.orb--stop:hover:not\(:disabled\) \{[\s\S]*?transform: none !important;/s,
    )
    expect(pullRequestCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pr-send-button:hover:not\(:disabled\) \{[\s\S]*?transform: none !important;/s,
    )
    expect(workspaceCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.workspace-side-chat__composer button:not\(:disabled\):hover \{[\s\S]*?transform: none !important;/s,
    )
  })
})
