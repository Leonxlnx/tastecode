import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listClaudeLocalCommands } from './local-commands.js'

describe('Claude Code skills and commands read from files', () => {
  let root: string
  let home: string
  let config: string
  let project: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'claude-local-commands-'))
    home = path.join(root, 'home')
    config = path.join(home, '.claude')
    project = path.join(root, 'project')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function file(target: string, content: string) {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  it("lists the user's and the project's skills and commands without starting Claude", async () => {
    await file(
      path.join(config, 'skills', 'taste-pro', 'SKILL.md'),
      [
        '---',
        'name: taste-pro',
        'description: >-',
        '  Builds professional company websites',
        '  with real photographs.',
        'argument-hint: "<what to build>"',
        '---',
        '',
        '# taste-pro',
      ].join('\n'),
    )
    await file(path.join(config, 'skills', 'notes', 'README.md'), 'not a skill')
    await file(path.join(config, 'commands', 'ship.md'), '# Ship the branch\n\nSteps.')
    await file(
      path.join(project, '.claude', 'skills', 'local-review', 'SKILL.md'),
      '---\ndescription: Review this repo\n---\n',
    )
    await file(
      path.join(project, '.claude', 'commands', 'deploy.md'),
      "---\ndescription: 'Deploy to staging'\n---\nRun it.",
    )

    const commands = await listClaudeLocalCommands(project, { environment: {}, home })

    expect(commands).toEqual([
      { name: 'local-review', description: 'Review this repo', source: 'custom' },
      { name: 'deploy', description: 'Deploy to staging', source: 'custom' },
      {
        name: 'taste-pro',
        description: 'Builds professional company websites with real photographs.',
        argumentHint: '<what to build>',
        source: 'custom',
      },
      { name: 'ship', description: 'Ship the branch', source: 'custom' },
    ])
  })

  it("lets the project's skill win over the user's one of the same name", async () => {
    await file(
      path.join(config, 'skills', 'review', 'SKILL.md'),
      '---\ndescription: User review\n---\n',
    )
    await file(
      path.join(project, '.claude', 'skills', 'review', 'SKILL.md'),
      '---\ndescription: Project review\n---\n',
    )

    const commands = await listClaudeLocalCommands(project, { environment: {}, home })

    expect(commands).toEqual([{ name: 'review', description: 'Project review', source: 'custom' }])
  })

  it('leaves out a skill only Claude may start', async () => {
    await file(
      path.join(config, 'skills', 'internal', 'SKILL.md'),
      '---\ndescription: Background\nuser-invocable: false\n---\n',
    )

    expect(await listClaudeLocalCommands(project, { environment: {}, home })).toEqual([])
  })

  it('lists the skills and commands of plugins that are turned on, under the plugin name', async () => {
    const enabled = path.join(root, 'cache', 'design-taste', '0.5.0')
    const disabled = path.join(root, 'cache', 'other', '1.0.0')
    await file(
      path.join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'design-taste@market': [{ scope: 'user', installPath: enabled }],
          'other@market': [{ scope: 'user', installPath: disabled }],
        },
      }),
    )
    await file(
      path.join(config, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'design-taste@market': true, 'other@market': false } }),
    )
    await file(
      path.join(enabled, 'skills', 'design-taste', 'SKILL.md'),
      '---\nname: design-taste\ndescription: Build pages\n---\n',
    )
    await file(path.join(enabled, 'commands', 'audit.md'), 'Audit a page')
    await file(path.join(disabled, 'skills', 'hidden', 'SKILL.md'), '---\ndescription: Off\n---\n')

    const commands = await listClaudeLocalCommands(project, { environment: {}, home })

    expect(commands).toEqual([
      {
        name: 'design-taste:design-taste',
        description: 'Build pages',
        source: 'plugin',
      },
      { name: 'design-taste:audit', description: 'Audit a page', source: 'plugin' },
    ])
  })

  it('reads the config folder CLAUDE_CONFIG_DIR names', async () => {
    const other = path.join(root, 'work-account')
    await file(path.join(other, 'skills', 'work', 'SKILL.md'), '---\ndescription: Work\n---\n')
    await file(path.join(config, 'skills', 'personal', 'SKILL.md'), '---\ndescription: Me\n---\n')

    const commands = await listClaudeLocalCommands(project, {
      environment: { CLAUDE_CONFIG_DIR: other },
      home,
    })

    expect(commands.map((command) => command.name)).toEqual(['work'])
  })

  it('answers an empty list when no folder exists', async () => {
    expect(await listClaudeLocalCommands(project, { environment: {}, home })).toEqual([])
  })
})
