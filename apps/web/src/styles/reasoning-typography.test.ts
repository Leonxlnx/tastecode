import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body']
}

describe('system typography', () => {
  const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

  it('uses the OS font before any named family, including before preferences initialize', () => {
    expect(tokens).toContain(
      "--font-system: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
    )
    expect(tokens.split(":root[data-font='system']")[0]).toContain('--font-ui: var(--font-system);')
    expect(tokens).toMatch(/:root\[data-font='system'\] \{\s*--font-ui: var\(--font-system\);\s*\}/)
  })

  it('keeps bundled fonts selectable with a native fallback', () => {
    expect(tokens).toContain("--font-ui: 'Geist Variable', var(--font-system);")
    expect(tokens).toContain("--font-ui: 'Inter Variable', var(--font-system);")
  })
})

describe('reasoning typography', () => {
  it('renders thinking as prose while keeping other operational output monospace', () => {
    expect(rule('.aux__out')).toContain('font-family: var(--font-mono)')
    expect(rule('.reasoning-summary')).toContain('font-family: var(--font-ui)')
  })
})
