import { describe, expect, it } from 'vitest'
import { channels, methods, DomainEventSchema } from '@harness/contracts'
import { parseStartupMethodResult } from './transport-startup-validation.js'
import { FAST_CHANNEL_FIELDS, parseChannelData } from './transport-validation.js'

const project = {
  path: '/project',
  name: 'Project',
  pinned: false,
  createdAt: 1,
  sessions: [
    {
      id: 'thread',
      title: 'Task',
      provider: 'codex',
      agent: 'agent',
      createdAt: 2,
      running: false,
      pinned: true,
      status: 'ready',
      unread: false,
      closedAt: 5,
      worktreeBranch: 'work',
      lifecycle: { state: 'active', keepActive: true, wokeAt: 3 },
    },
  ],
}
const provider = {
  id: 'codex',
  displayName: 'Codex',
  installed: true,
  version: '1',
  auth: 'authenticated',
  problem: '',
  capabilities: {
    steer: true,
    fork: false,
    interrupt: true,
    reasoningItems: true,
    approvals: true,
    userInput: true,
    autoReview: false,
    images: true,
  },
  setup: {
    installUrl: 'https://example.com',
    installCommand: 'install',
    login: 'app',
    loginOpensBrowser: true,
  },
}

/** Change each supplied field independently, including every nested schema field. */
function* mutations(value: unknown): Generator<unknown> {
  yield value
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      for (const next of mutations(value[index]))
        yield value.map((item, at) => (at === index ? next : item))
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      const object = value as Record<string, unknown>
      const removed = { ...object }
      delete removed[key]
      yield removed
      for (const bad of [
        undefined,
        null,
        true,
        17,
        -1,
        1.5,
        NaN,
        Infinity,
        '',
        'unexpected',
        [],
        {},
      ])
        yield { ...object, [key]: bad }
      if (typeof object[key] === 'object')
        for (const next of mutations(object[key])) yield { ...object, [key]: next }
    }
  }
}

describe('fast validation canonical parity', () => {
  it.each([
    ['projects.list', { projects: [project] }],
    ['providers.list', { providers: [provider] }],
  ] as const)('matches acceptance for every nested field of %s', (method, fixture) => {
    for (const value of mutations(fixture)) {
      const fast = parseStartupMethodResult(method, value)
      const canonical = methods[method].result.safeParse(value)
      expect(fast !== undefined, JSON.stringify(value)).toBe(canonical.success)
      if (fast !== undefined) expect(fast).toBe(value)
    }
  })

  it.each([
    { state: 'settled', settledAt: 2, reason: 'manual' },
    { state: 'snoozed', snoozedAt: 2, wakeAt: 4 },
  ])('covers every lifecycle variant: $state', (lifecycle) => {
    const fixture = {
      projects: [{ ...project, sessions: [{ ...project.sessions[0], lifecycle }] }],
    }
    for (const value of mutations(fixture))
      expect(parseStartupMethodResult('projects.list', value) !== undefined).toBe(
        methods['projects.list'].result.safeParse(value).success,
      )
  })

  it.each(['thread.event', 'sideChat.event', 'terminal.output'] as const)(
    'matches canonical parsing for %s',
    (channel) => {
      const fixture =
        channel === 'terminal.output'
          ? { terminalId: 'terminal', data: 'text', outputOffset: 7 }
          : {
              threadId: 'thread',
              seq: 9,
              event: { type: 'item.delta', turnId: 'turn', itemId: 'item', textDelta: 'text' },
            }
      for (const value of mutations(fixture)) {
        const expected = channels[channel].safeParse(value)
        if (expected.success) expect(parseChannelData(channel, value)).toEqual(expected.data)
        else expect(() => parseChannelData(channel, value)).toThrow()
      }
    },
  )

  it('pins full fast-path field coverage to canonical schemas', () => {
    expect(Object.keys(FAST_CHANNEL_FIELDS.terminal).sort()).toEqual(
      Object.keys(channels['terminal.output'].shape).sort(),
    )
    expect(Object.keys(FAST_CHANNEL_FIELDS.thread).sort()).toEqual(
      Object.keys(channels['thread.event'].shape).sort(),
    )
    expect(Object.keys(FAST_CHANNEL_FIELDS.sideChat).sort()).toEqual(
      Object.keys(channels['sideChat.event'].shape).sort(),
    )
    const delta = DomainEventSchema.options.find(
      (schema) => schema.shape.type.value === 'item.delta',
    )!
    expect(Object.keys(FAST_CHANNEL_FIELDS.delta).sort()).toEqual(Object.keys(delta.shape).sort())
  })
})
