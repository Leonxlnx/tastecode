import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('.', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('clipboard writes', () => {
  // The desktop session denies `clipboard-sanitized-write`, so a direct
  // navigator.clipboard write rejects there. writeClipboardText goes through
  // the desktop bridge and falls back to navigator.clipboard on the web.
  it('go through writeClipboardText instead of navigator.clipboard', () => {
    const direct = sourceFiles(sourceRoot)
      .filter((path) => relative(sourceRoot, path) !== 'bridge.ts')
      .filter((path) => readFileSync(path, 'utf8').includes('navigator.clipboard'))
      .map((path) => relative(sourceRoot, path))
    expect(direct).toEqual([])
  })
})
