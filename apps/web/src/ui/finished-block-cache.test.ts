import { expect, it } from 'vitest'
import { createFinishedBlockCache } from './finished-block-cache.js'
import { createBlockSplitter } from './markdown-blocks.js'

function finishStream() {
  const split = createBlockSplitter()
  let text = ''
  const rows: WeakRef<string[]>[] = []
  for (let i = 0; i < 160; i++) {
    text += `${i} ${'streamed paragraph '.repeat(8)}\n\n`
    rows.push(new WeakRef(split(text)))
  }
  const local = split(text)
  const charge = 128 + 2 * text.length + local.reduce((sum, s) => sum + 64 + 2 * s.length, 0)
  const cache = createFinishedBlockCache(charge)
  const resident = cache(text, split)
  expect(resident).toEqual(local)
  expect(resident).not.toBe(local)
  expect(createFinishedBlockCache(charge - 1)(text, split)).toBe(local)
  local.length = 0
  return { rows, checkHit: () => expect(cache(text, () => [])).toBe(resident) }
}

it('owns the finished blocks after releasing a streamed row and charges their full size', async () => {
  const { rows, checkHit } = finishStream()
  if (globalThis.gc) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    globalThis.gc()
    expect(rows.every((row) => row.deref() === undefined)).toBe(true)
  }
  checkHit()
})
