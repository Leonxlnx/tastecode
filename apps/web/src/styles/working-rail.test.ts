import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')
const thread = readFileSync(new URL('../ui/Thread.tsx', import.meta.url), 'utf8')

describe('working rail footprint', () => {
  it('reserves the same room at the runway end as the rail anchor row pads', () => {
    // The runway keeps this room before the first response row exists; the
    // row that takes over pads exactly as much, so nothing moves between them.
    const css42 = css.match(/--working-rail-h: (\d+)px;/)?.[1]
    const ts42 = thread.match(/const WORKING_RAIL_PX = (\d+)/)?.[1]
    expect(css42).toBeDefined()
    expect(ts42).toBe(css42)
    expect(css).toContain('padding-top: var(--working-rail-h);')
  })
})
