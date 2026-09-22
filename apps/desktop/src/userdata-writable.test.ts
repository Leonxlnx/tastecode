import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writableOrCreatable } from './userdata-writable.js'

const created: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'userdata-writable-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop()!
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Already writable or already gone.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('writableOrCreatable', () => {
  it('accepts an existing writable directory', () => {
    expect(writableOrCreatable(tempRoot())).toBe(true)
  })

  it('accepts a nested path whose existing ancestor is writable', () => {
    expect(writableOrCreatable(join(tempRoot(), 'a', 'b', 'c'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects a path under a read-only ancestor', () => {
    const root = tempRoot()
    chmodSync(root, 0o555)
    expect(writableOrCreatable(join(root, 'TasteCode'))).toBe(false)
  })
})
