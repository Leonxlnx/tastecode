import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSkillsRoot, isDefaultSkillId, loadDefaultSkills } from './default-skills.js'
import { writeDefaultSkillsFixture } from './default-skills.test-support.js'

const temporary: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tc-default-skills-'))
  temporary.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

describe('default skills', () => {
  it('lists the bundled skills as read-only system skills with a short catalog', async () => {
    const root = await writeDefaultSkillsFixture(await tempDir())
    const loaded = loadDefaultSkills(root)

    expect(loaded.skills.map((skill) => [skill.id, skill.name, skill.scope])).toEqual([
      ['tastecode:cinetic', 'cinetic', 'system'],
      ['tastecode:design-taste-frontend', 'design-taste-frontend', 'system'],
      ['tastecode:cook', 'cook', 'system'],
    ])
    expect(loaded.skills[0]).toMatchObject({
      description: 'The long cinetic description.',
      source: { type: 'folder', path: path.join(root, 'skills', 'cinetic') },
      enabled: true,
    })
    expect(loaded.catalog).toContain(`one folder each in ${path.join(root, 'skills')}.`)
    expect(loaded.catalog).toContain('- cinetic: cinematic videos and motion design made in code\n')
    expect(loaded.catalog).toContain('never in a Design mode run')
    expect(loaded.skills.every((skill) => isDefaultSkillId(skill.id))).toBe(true)
    expect(loaded.commands).toEqual(
      ['cinetic', 'design-taste-frontend', 'cook'].map((name) => ({
        name,
        description: `The long ${name} description.`,
        aliases: [`tastecode:${name}`],
        kind: 'skill',
        source: 'plugin',
      })),
    )
  })

  it('uses the skill name with a manifest plugin alias, and lists none without a plugin', async () => {
    const root = await writeDefaultSkillsFixture(await tempDir(), ['cook'])
    await writeFile(
      path.join(root, 'skills.json'),
      JSON.stringify({ plugin: { name: 'acme' }, skills: [{ folder: 'cook' }] }),
    )
    await writeFile(
      path.join(root, 'skills', 'cook', 'SKILL.md'),
      '---\nname: cook-loop\ndescription: Loops.\n---\n',
    )
    expect(loadDefaultSkills(root).commands).toEqual([
      {
        name: 'cook-loop',
        description: 'Loops.',
        aliases: ['acme:cook'],
        kind: 'skill',
        source: 'plugin',
      },
    ])

    await writeFile(
      path.join(root, 'skills.json'),
      JSON.stringify({ skills: [{ folder: 'cook' }] }),
    )
    const unnamed = loadDefaultSkills(root)
    expect(unnamed.skills.map((skill) => skill.name)).toEqual(['cook-loop'])
    expect(unnamed.commands).toEqual([])
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['colon', 'acme:cook'],
    ['whitespace', 'cook loop'],
    ['leading slash', '/cook'],
    ['over 200 characters', 'c'.repeat(201)],
  ])('keeps the qualified name when the skill name is %s', async (_label, name) => {
    const root = await writeDefaultSkillsFixture(await tempDir(), ['cook'])
    await writeFile(
      path.join(root, 'skills', 'cook', 'SKILL.md'),
      `---\n${name === undefined ? '' : `name: ${JSON.stringify(name)}\n`}description: Loops.\n---\n`,
    )
    expect(loadDefaultSkills(root).commands).toEqual([
      {
        name: 'tastecode:cook',
        description: 'Loops.',
        kind: 'skill',
        source: 'plugin',
      },
    ])
  })

  it('accepts a trimmed bare name at the 200-character limit', async () => {
    const root = await writeDefaultSkillsFixture(await tempDir(), ['cook'])
    const name = 'c'.repeat(200)
    await writeFile(
      path.join(root, 'skills', 'cook', 'SKILL.md'),
      `---\nname: "  ${name}  "\n---\n`,
    )
    expect(loadDefaultSkills(root).commands).toEqual([
      {
        name,
        description: '',
        aliases: ['tastecode:cook'],
        kind: 'skill',
        source: 'plugin',
      },
    ])
  })

  it('keeps the catalog under 700 characters for a long install path', async () => {
    const deep = path.join(
      await tempDir(),
      'Users',
      'someone-with-a-long-name',
      'AppData',
      'Local',
      'Programs',
      'Taste Code',
      'resources',
    )
    await mkdir(deep, { recursive: true })
    const loaded = loadDefaultSkills(await writeDefaultSkillsFixture(deep))

    expect(loaded.skills).toHaveLength(3)
    expect(loaded.catalog.length).toBeLessThan(700)
  })

  it('lists only skills that are on disk, and nothing without a bundle', async () => {
    const partial = loadDefaultSkills(await writeDefaultSkillsFixture(await tempDir(), ['cook']))
    expect(partial.skills.map((skill) => skill.name)).toEqual(['cook'])
    expect(partial.catalog).not.toContain('cinetic')

    const missing = loadDefaultSkills(path.join(await tempDir(), 'no-bundle'))
    expect(missing).toMatchObject({ skills: [], commands: [], catalog: '' })
  })

  it('reads the packaged folder from the environment and the workspace copy otherwise', () => {
    expect(defaultSkillsRoot({ HARNESS_DEFAULT_SKILLS_DIR: '/app/resources/default-skills' })).toBe(
      path.resolve('/app/resources/default-skills'),
    )
    expect(defaultSkillsRoot({})).toBe(
      path.resolve(import.meta.dirname, '..', '..', '..', 'packages', 'default-skills', 'bundle'),
    )
  })
})
