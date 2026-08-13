import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browseProjectDirectory } from './project-directory-browser.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('project directory browser', () => {
  it('starts at home, hides dotfiles, and lists navigable folders and files', async () => {
    const home = await temporaryDirectory()
    await mkdir(path.join(home, 'Developer'))
    await writeFile(path.join(home, 'notes.txt'), 'hello')
    await mkdir(path.join(home, '.secrets'))

    const listing = await browseProjectDirectory(undefined, home)

    expect(listing.path).toBe(await realpath(home))
    expect(listing.parent).toBeUndefined()
    expect(listing.entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'Developer', kind: 'directory' },
      { name: 'notes.txt', kind: 'file' },
    ])
  })

  it('returns a parent inside home and refuses paths outside it', async () => {
    const home = await temporaryDirectory()
    const project = path.join(home, 'Developer', 'harness')
    await mkdir(project, { recursive: true })
    const outside = await temporaryDirectory()

    const listing = await browseProjectDirectory(project, home)

    expect(listing.parent).toBe(await realpath(path.join(home, 'Developer')))
    await expect(browseProjectDirectory(outside, home)).rejects.toThrow(
      'can only browse inside your home folder',
    )
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-project-browser-'))
  temporaryDirectories.push(directory)
  return directory
}
