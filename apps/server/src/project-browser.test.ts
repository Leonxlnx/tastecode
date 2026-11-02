import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browseFolders } from './project-browser.js'

const made: string[] = []

function home(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'browse-home-')))
  made.push(root)
  mkdirSync(path.join(root, 'zeta'))
  mkdirSync(path.join(root, 'App 2'))
  mkdirSync(path.join(root, 'App 10'))
  mkdirSync(path.join(root, '.secret'))
  mkdirSync(path.join(root, 'repo', '.git'), { recursive: true })
  writeFileSync(path.join(root, 'notes.txt'), 'x')
  return root
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('project folder browser', () => {
  it('starts at home and lists only visible folders in natural order', async () => {
    const root = home()
    const result = await browseFolders(undefined, {
      home: root,
      projects: new Set([path.join(root, 'zeta')]),
      platform: 'linux',
    })
    expect(result.path).toBe(root)
    expect(result.parent).toBeUndefined()
    expect(result.roots).toEqual([{ name: 'Home', path: root }])
    expect(result.folders.map((folder) => folder.name)).toEqual(['App 2', 'App 10', 'repo', 'zeta'])
    expect(result.folders.find((folder) => folder.name === 'repo')?.repository).toBe(true)
    expect(result.folders.find((folder) => folder.name === 'zeta')?.added).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it('walks down and back up without leaving the home folder', async () => {
    const root = home()
    const inner = await browseFolders(path.join(root, 'repo'), { home: root, platform: 'linux' })
    expect(inner.parent).toBe(root)
    expect(inner.folders).toEqual([])
    await expect(
      browseFolders(path.dirname(root), { home: root, platform: 'linux' }),
    ).rejects.toThrow(/home folder/)
  })

  it('does not follow a link out of the home folder', async () => {
    const root = home()
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'browse-outside-')))
    made.push(outside)
    symlinkSync(outside, path.join(root, 'escape'), 'dir')
    const result = await browseFolders(undefined, { home: root, platform: 'linux' })
    expect(result.folders.map((folder) => folder.name)).not.toContain('escape')
    await expect(
      browseFolders(path.join(root, 'escape'), { home: root, platform: 'linux' }),
    ).rejects.toThrow()
  })

  it('reports a folder that is gone', async () => {
    const root = home()
    await expect(
      browseFolders(path.join(root, 'missing'), { home: root, platform: 'linux' }),
    ).rejects.toThrow('That folder is no longer available')
  })
})
