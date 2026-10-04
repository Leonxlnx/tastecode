import { bench, describe } from 'vitest'
import { indexedTextLine, indexTextLines } from './text-line-index.js'

const CONTENT = 'const value = 1234567890;\n'.repeat(80_000)
const OPTIONS = { time: 1_200, warmupTime: 300 }

describe('large text line storage', () => {
  bench(
    'splits a 2 MB file into retained strings',
    () => {
      const lines = CONTENT.split('\n')
      if (lines.length !== 80_001) throw new Error('invalid split lines')
    },
    OPTIONS,
  )

  bench(
    'indexes a 2 MB file in a compact typed array',
    () => {
      const index = indexTextLines(CONTENT)
      if (index.length !== 80_001) throw new Error('invalid indexed lines')
    },
    OPTIONS,
  )

  const splitLines = CONTENT.split('\n')
  const lineIndex = indexTextLines(CONTENT)
  let nextLine = 0

  bench(
    'reads 64 visible split lines',
    () => {
      let checksum = 0
      for (let offset = 0; offset < 64; offset += 1) {
        checksum += splitLines[(nextLine + offset) % 80_000]!.length
      }
      nextLine = (nextLine + 64) % 80_000
      if (checksum === 0) throw new Error('invalid split line read')
    },
    OPTIONS,
  )

  bench(
    'reads 64 visible indexed lines',
    () => {
      let checksum = 0
      for (let offset = 0; offset < 64; offset += 1) {
        checksum += indexedTextLine(CONTENT, lineIndex, (nextLine + offset) % 80_000).length
      }
      nextLine = (nextLine + 64) % 80_000
      if (checksum === 0) throw new Error('invalid indexed line read')
    },
    OPTIONS,
  )
})
