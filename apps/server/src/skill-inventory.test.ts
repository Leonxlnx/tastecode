import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listLocalSkills, mergeSkills, projectSkillsDir, userSkillsDir } from './skill-inventory.js'

const roots: string[] = []

function temporary(name: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `harness-${name}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local skill inventory', () => {
  it('names project and user Agent Skills from SKILL.md frontmatter', async () => {
    const project = temporary('project')
    const homeSkills = path.join(temporary('home'), '.agents', 'skills')
    writeSkill(path.join(projectSkillsDir(project), 'docs'), {
      name: 'docs',
      description: 'Read product documentation',
    })
    writeSkill(path.join(homeSkills, 'animate'), {
      name: 'animate',
      description: 'Build an animation from scratch',
    })

    await expect(listLocalSkills(project, { userSkillsDir: homeSkills })).resolves.toEqual({
      skills: [
        {
          id: path.join(projectSkillsDir(project), 'docs', 'SKILL.md'),
          name: 'docs',
          description: 'Read product documentation',
          source: { type: 'folder', path: path.join(projectSkillsDir(project), 'docs') },
          scope: 'project',
          enabled: true,
          dependencyErrors: [],
        },
        {
          id: path.join(homeSkills, 'animate', 'SKILL.md'),
          name: 'animate',
          description: 'Build an animation from scratch',
          source: { type: 'folder', path: path.join(homeSkills, 'animate') },
          scope: 'user',
          enabled: true,
          dependencyErrors: [],
        },
      ],
      errors: [],
    })
  })

  it('uses the folder name when frontmatter has no name', async () => {
    const project = temporary('project')
    const homeSkills = path.join(temporary('home'), '.agents', 'skills')
    writeSkill(
      path.join(homeSkills, 'review-animations'),
      '---\ndescription: Critique motion.\n---\n',
    )

    const inventory = await listLocalSkills(project, { userSkillsDir: homeSkills })
    expect(inventory.skills).toEqual([
      expect.objectContaining({
        name: 'review-animations',
        description: 'Critique motion.',
        scope: 'user',
      }),
    ])
  })

  it('skips missing skill roots without reporting an error', async () => {
    const project = temporary('project')
    await expect(
      listLocalSkills(project, { userSkillsDir: path.join(project, 'missing-user-skills') }),
    ).resolves.toEqual({ skills: [], errors: [] })
  })

  it('keeps vendor skills first when merging a local inventory', () => {
    const vendor = {
      id: '/repo/.agents/skills/docs/SKILL.md',
      name: 'docs',
      description: 'Vendor docs',
      source: { type: 'folder' as const, path: '/repo/.agents/skills/docs' },
      scope: 'project' as const,
      enabled: false,
      dependencyErrors: [],
    }
    const local = {
      ...vendor,
      description: 'Disk docs',
      enabled: true,
    }
    const extra = {
      id: '/home/.agents/skills/animate/SKILL.md',
      name: 'animate',
      description: 'Build motion',
      source: { type: 'folder' as const, path: '/home/.agents/skills/animate' },
      scope: 'user' as const,
      enabled: true,
      dependencyErrors: [],
    }

    expect(mergeSkills([vendor], [local, extra])).toEqual([vendor, extra])
  })
})

describe('skill locations', () => {
  it('keeps user skills under the shared Agent Skills home', () => {
    expect(userSkillsDir('/Users/me')).toBe(path.join('/Users/me', '.agents', 'skills'))
  })
})

function writeSkill(folder: string, body: { name: string; description: string } | string): void {
  mkdirSync(folder, { recursive: true })
  const markdown =
    typeof body === 'string'
      ? body
      : `---\nname: ${body.name}\ndescription: ${body.description}\n---\n`
  writeFileSync(path.join(folder, 'SKILL.md'), markdown)
}
