import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installLocalSkill } from './skill-install.js'

const roots: string[] = []

function temporary(name: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `harness-${name}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local skill installation', () => {
  it('copies a valid skill without overwriting a conflict', async () => {
    const project = temporary('project')
    const source = path.join(temporary('source'), 'review-skill')
    mkdirSync(path.join(source, 'references'), { recursive: true })
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: review-skill\n---\n')
    writeFileSync(path.join(source, 'references', 'notes.md'), 'notes')

    const destination = await installLocalSkill(project, source)

    expect(readFileSync(path.join(destination, 'references', 'notes.md'), 'utf8')).toBe('notes')
    await expect(installLocalSkill(project, source)).rejects.toThrow(
      'project skill "review-skill" already exists',
    )
  })

  it('rejects a symlink that escapes the selected folder', async () => {
    const project = temporary('project')
    const source = path.join(temporary('source'), 'unsafe-skill')
    const outside = temporary('outside')
    mkdirSync(source, { recursive: true })
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: unsafe-skill\n---\n')
    symlinkSync(
      outside,
      path.join(source, 'outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(installLocalSkill(project, source)).rejects.toThrow(
      'skill folder contains a symlink outside the selected folder',
    )
    expect(() =>
      readFileSync(path.join(project, '.agents', 'skills', 'unsafe-skill', 'SKILL.md')),
    ).toThrow()
  })
})
