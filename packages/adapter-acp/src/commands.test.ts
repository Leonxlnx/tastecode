import { readFileSync } from 'node:fs'
import { methods, ProviderCommandSchema } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { acpCommandSkillPath, mapAcpCommands } from './commands.js'
import { SessionNotificationSchema } from './protocol.js'

/** A sanitized `available_commands_update` from grok 1.0.62 `agent stdio`, no prompt sent. */
const captured = SessionNotificationSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('./fixtures/available-commands-grok-1.0.62.json', import.meta.url),
      'utf8',
    ),
  ),
)

describe('ACP available commands', () => {
  it('maps the captured Grok list with hints and skills', () => {
    const commands = mapAcpCommands(captured.update?.availableCommands ?? [])
    expect(commands).toHaveLength(13)
    expect(commands[0]).toEqual({
      name: 'compact',
      description: 'Compress the conversation to free context',
    })
    expect(commands.find((command) => command.name === 'always-approve')).toEqual({
      name: 'always-approve',
      description: 'Turn always-approve mode on or off',
      argumentHint: 'on|off',
    })
    // A workflow is a command; a SKILL.md file makes a skill, under the name the agent runs.
    expect(commands.find((command) => command.name === 'deep-research')?.kind).toBeUndefined()
    expect(
      commands.filter((command) => command.kind === 'skill').map((command) => command.name),
    ).toEqual([
      'user:help',
      'release-notes',
      'brand-voice-old',
      'code-review',
      'bundled:imagine',
      'design-kit',
    ])
    for (const command of commands) expect(ProviderCommandSchema.parse(command)).toEqual(command)
    expect(methods['commands.list'].result.parse({ commands, loading: false }).commands).toEqual(
      commands,
    )
  })

  it('drops malformed and duplicate entries without losing the rest', () => {
    expect(
      mapAcpCommands([
        null,
        'compact',
        { description: 'no name' },
        { name: '' },
        { name: 'two words' },
        { name: '/review', description: 'Review changes', input: { hint: '  <ref>  ' } },
        { name: 'review', description: 'A second review' },
        { name: 'plan', description: null, input: 'not an object', _meta: [] },
        { name: 'x'.repeat(201) },
        { name: 'long', input: { hint: 'h'.repeat(300) } },
      ]),
    ).toEqual([
      { name: 'review', description: 'Review changes', argumentHint: '<ref>' },
      { name: 'plan', description: '' },
      { name: 'long', description: '', argumentHint: `${'h'.repeat(199)}…` },
    ])
  })

  it('recognises a skill only by its SKILL.md path', () => {
    expect(acpCommandSkillPath({ _meta: { path: '/home/a/.grok/skills/x/SKILL.md' } })).toBe(
      '/home/a/.grok/skills/x/SKILL.md',
    )
    expect(acpCommandSkillPath({ _meta: { path: 'C:\\a\\skill.md' } })).toBe('C:\\a\\skill.md')
    expect(acpCommandSkillPath({ _meta: { path: 'C:\\a\\NOTSKILL.md' } })).toBeUndefined()
    expect(acpCommandSkillPath({ _meta: { workflowPath: 'C:\\a\\run.rhai' } })).toBeUndefined()
  })
})
