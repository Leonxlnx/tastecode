import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return tokens.match(new RegExp(`\\n${escaped} \\{(?<body>[^}]*)\\}`))?.groups?.body ?? ''
}

describe('workspace terminal background', () => {
  it('follows the app background in dark and its neutral surface in light', () => {
    expect(block(':root')).toContain('--terminal-workspace-bg: var(--bg);')
    expect(block(":root[data-theme='light']")).toContain('--terminal-workspace-bg: var(--surface);')
  })

  it('keeps backdrop presets and custom colours from pinning their own terminal colour', () => {
    const pinned = tokens.match(/--terminal-workspace-bg: #[0-9a-f]+;/gi) ?? []
    expect(pinned).toEqual([])
    expect(block(":root[data-theme='light'][data-backdrop='custom']")).not.toContain(
      '--terminal-workspace-bg',
    )
  })
})
