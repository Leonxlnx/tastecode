import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createChatFolder, isChatFolder } from './chat-folder.js'

const roots: string[] = []

function tempRoot(): string {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tastecode-chat-folders-'))
  roots.push(parent)
  return path.join(parent, 'threads')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('chat folders', () => {
  const now = new Date(2026, 10, 1, 9, 30)

  it('names a new folder after the local date and two words', () => {
    const root = tempRoot()
    const folder = createChatFolder(root, { now, random: () => 0 })
    expect(folder).toBe(path.join(root, '2026-11-01-amber-badger'))
    expect(existsSync(folder)).toBe(true)
    expect(readdirSync(folder)).toEqual([])
  })

  it('never reuses a folder that exists already', () => {
    const root = tempRoot()
    const taken = path.join(root, '2026-11-01-amber-badger')
    mkdirSync(taken, { recursive: true })
    let call = 0
    // The first name is taken; the retry draws the last words of both lists.
    const folder = createChatFolder(root, { now, random: () => (call++ < 2 ? 0 : 0.999) })
    expect(folder).toBe(path.join(root, '2026-11-01-velvet-wren'))
  })

  it('numbers the name once random words keep colliding', () => {
    const root = tempRoot()
    mkdirSync(path.join(root, '2026-11-01-amber-badger'), { recursive: true })
    mkdirSync(path.join(root, '2026-11-01-amber-badger-2'))
    const folder = createChatFolder(root, { now, random: () => 0 })
    expect(folder).toBe(path.join(root, '2026-11-01-amber-badger-3'))
  })

  it('recognises only folders directly inside the root', () => {
    const root = path.join(path.sep, 'home', 'me', '.tastecode', 'threads')
    expect(isChatFolder(root, path.join(root, '2026-11-01-amber-badger'))).toBe(true)
    expect(isChatFolder(root, root)).toBe(false)
    expect(isChatFolder(root, path.join(root, 'a', 'b'))).toBe(false)
    expect(isChatFolder(root, path.join(path.sep, 'repo'))).toBe(false)
  })
})
