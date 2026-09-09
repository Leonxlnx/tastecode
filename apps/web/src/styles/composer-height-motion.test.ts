import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../ui/Composer.tsx', import.meta.url), 'utf8')
const pullRequestCss = readFileSync(
  new URL('../ui/pull-requests/pull-requests.css', import.meta.url),
  'utf8',
)

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('composer height motion', () => {
  it('keeps the main composer autosize limits but removes CSS height motion', () => {
    const composer = rule(appCss, '.composer textarea')

    expect(composer).toContain('min-height: 48px')
    expect(composer).toContain('max-height: 242px')
    expect(composer).toContain('padding: 12px 16px 6px')
    expect(composerSource).toContain('const COMPOSER_MIN_HEIGHT = 48')
    expect(composerSource).toContain('rows={1}')
    expect(composer).not.toContain('transition:')
    expect(composer).not.toContain('animation:')
  })

  it('keeps the pull request composer autosize limits but removes CSS height motion', () => {
    const composer = rule(pullRequestCss, '.pr-composer textarea')

    expect(composer).toContain('min-height: 62px')
    expect(composer).toContain('max-height: 160px')
    expect(composer).not.toContain('transition:')
    expect(composer).not.toContain('animation:')
  })
})
