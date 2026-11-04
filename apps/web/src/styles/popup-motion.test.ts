import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./popup-motion.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    css.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ?? ''
  )
}

describe('menu and popover motion', () => {
  it('opens from the anchor with the shared spring and closes faster in place', () => {
    expect(tokens).toContain('--ease-popup: cubic-bezier(0.2, 0.9, 0.25, 1);')
    expect(tokens).toContain('--dur-popup-in: 160ms;')
    expect(tokens).toContain('--dur-popup-out: 110ms;')

    const closed = rule('.popup')
    expect(closed).toContain('transform: scale(0.98);')
    expect(closed).toContain('transform var(--dur-popup-out) var(--ease-out)')
    expect(closed).toContain('opacity var(--dur-popup-out) var(--ease-out)')

    const open = rule(".popup[data-popup-state='open']")
    expect(open).toContain('transform var(--dur-popup-in) var(--ease-popup)')
    expect(open).toContain('opacity var(--dur-popup-in) var(--ease-popup)')
    expect(css).toMatch(
      /@starting-style \{\s*\.popup\[data-popup-state='open'\] \{\s*opacity: 0;\s*transform: translateY\(var\(--popup-offset\)\) scale\(0\.96\);/,
    )
  })

  it('only fades under reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.popup,\s*\.popup\[data-popup-state='open'\],[\s\S]*?transform: none;\s*transition: opacity 100ms var\(--ease-out\) !important;/,
    )
  })
})
