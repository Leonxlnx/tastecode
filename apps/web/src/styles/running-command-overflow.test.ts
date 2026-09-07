import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body']
}

describe('running command overflow', () => {
  it('truncates a long command before it widens the transcript', () => {
    expect(rule('.activity--live .activity__summary')).toContain('width: 100%')
    expect(rule('.activity--live .activity__summary')).toContain('min-width: 0')
    expect(rule('.activity--live .activity__label')).toContain('flex: 1 1 0')
    expect(rule('.activity__label')).toContain('text-overflow: ellipsis')

    expect(rule('.activity__working-label-swap')).toContain('flex: 1 1 0')
    expect(rule('.activity__working-label-swap')).toContain('overflow: hidden')
    expect(rule('.activity__working-status,\n.activity__working-status-previous')).toContain(
      'overflow: hidden',
    )
    expect(rule('.activity__working-label,\n.activity__working-label-previous')).toContain(
      'text-overflow: ellipsis',
    )
    expect(rule('.activity__working-time')).toContain('flex: none')
  })
})
