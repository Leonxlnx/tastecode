import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./workspace-agents.css', import.meta.url), 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)
  if (!match) throw new Error(`no rule for ${selector}`)
  return match[1]!
}

describe('a sub-agent transcript in the Agents tab', () => {
  it('is the chat pane its column sizes from, so it never runs past the panel', () => {
    // The shared chat column reads 100cqi. Without a container here it measured a
    // wider pane further out and the transcript ran past the panel's right edge.
    const transcript = ruleBody('.agent-detail__transcript')
    expect(transcript).toContain('container: agent-transcript / inline-size;')
    expect(transcript).toContain('min-width: 0;')
  })
})
