import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DomainEvent } from '@harness/contracts'
import { spawnCli } from '@harness/proc'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from './adapter.js'
import { CLAUDE_RUNTIMES, type ClaudeRuntime } from './capabilities.js'
import { claudeLimitSource } from './limits.js'
import type { ClaudeSpawn } from './sdk-runtime.js'

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-claude-cli.mjs', import.meta.url))

type Launch = { argv: string[]; entrypoint: string | null; nodeOptions: string | null }

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Starts the stand-in wherever the runtime would start `claude`, and records each launch. */
function fakeClaude() {
  const directory = mkdtempSync(path.join(tmpdir(), 'harness-claude-runtime-'))
  directories.push(directory)
  const log = path.join(directory, 'launches.jsonl')
  const spawn: ClaudeSpawn = (command, args, options = {}) => {
    expect(command).toBe('claude')
    return spawnCli(process.execPath, [FAKE_CLI, ...args], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_LOG: log },
    })
  }
  const launches = (): Launch[] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Launch)
  // A Claude Code host (this test may run inside one) exports its own entrypoint and session.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_SDK)/.test(name),
    ),
  )
  return { spawn, launches, environment: { ...environment, NODE_OPTIONS: '--no-warnings' } }
}

function waitFor<T>(events: DomainEvent[], find: (event: DomainEvent) => T | undefined) {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const check = () => {
      for (const event of events) {
        const found = find(event)
        if (found !== undefined) return resolve(found)
      }
      if (Date.now() > deadline) return reject(new Error('timed out waiting for an event'))
      setTimeout(check, 10)
    }
    check()
  })
}

/** What a chat sees, without the ids and times that differ between runs. */
function shape(event: DomainEvent) {
  switch (event.type) {
    case 'item.started':
    case 'item.completed': {
      const { id: _id, turnId: _turnId, createdAt: _createdAt, ...item } = event.item
      return { type: event.type, item }
    }
    case 'item.delta':
      return { type: event.type, textDelta: event.textDelta }
    case 'turn.started':
      return { type: event.type }
    case 'turn.completed':
      return { type: event.type, status: event.status }
    case 'approval.requested': {
      const { id: _id, createdAt: _createdAt, ...request } = event.request
      return { type: event.type, request }
    }
    case 'approval.resolved':
      return { type: event.type }
    default:
      return event
  }
}

/** One session through every control the chat uses; returns what the chat saw. */
async function exercise(runtime: ClaudeRuntime) {
  const fake = fakeClaude()
  const adapter = new ClaudeCodeAdapter({
    runtime,
    spawn: fake.spawn,
    environment: fake.environment,
  })
  const events: DomainEvent[] = []
  adapter.on('event', (event) => events.push(event))
  try {
    const thread = await adapter.startThread(process.cwd(), {
      approval: 'ask',
      instructions: 'Answer briefly.',
    })
    const completed = (turnId: string) =>
      waitFor(events, (event) =>
        event.type === 'turn.completed' && event.turnId === turnId ? event.status : undefined,
      )

    const reply = await adapter.sendTurn(thread.id, 'Say hello')
    expect(await completed(reply)).toBe('completed')

    const tool = await adapter.sendTurn(thread.id, 'Use a tool')
    const approval = await waitFor(events, (event) =>
      event.type === 'approval.requested' ? event.request : undefined,
    )
    adapter.respondToApproval(approval.id, 'approve')
    expect(await completed(tool)).toBe('completed')

    const stopped = await adapter.sendTurn(thread.id, 'Please wait')
    await waitFor(events, (event) =>
      event.type === 'turn.started' && event.turn.id === stopped ? true : undefined,
    )
    await adapter.interrupt()
    expect(await completed(stopped)).toBe('interrupted')

    await adapter.setApproval('auto')
    const commands = await adapter.listCommands(thread.id)
    const servers = await adapter.listMcpServers(thread.id)
    const models = await adapter.listModels()
    return { events: events.map(shape), commands, servers, models, launches: fake.launches() }
  } finally {
    await adapter.dispose()
  }
}

describe('Claude runtimes', () => {
  it('declares the Agent SDK as the default and claude -p beside it', () => {
    expect(CLAUDE_RUNTIMES.map((runtime) => runtime.id)).toEqual(['sdk', 'cli'])
  })

  it('gives a chat the same session through claude -p as through the Agent SDK', async () => {
    const sdk = await exercise('sdk')
    const cli = await exercise('cli')

    expect(cli.events).toEqual(sdk.events)
    expect(cli.commands).toEqual(sdk.commands)
    expect(cli.servers).toEqual(sdk.servers)
    expect(cli.models).toEqual(sdk.models)
    expect(cli.events).toContainEqual({ type: 'item.delta', textDelta: 'Hello ' })
    expect(cli.events).toContainEqual(expect.objectContaining({ type: 'approval.requested' }))
    expect(cli.commands.map((command) => command.name)).toContain('review')
    expect(cli.servers.map((server) => server.id)).toContain('fixture')
  }, 30_000)

  it('passes the same session flags through claude -p', async () => {
    const launch = async (runtime: ClaudeRuntime) => {
      const fake = fakeClaude()
      const adapter = new ClaudeCodeAdapter({
        runtime,
        spawn: fake.spawn,
        environment: fake.environment,
      })
      try {
        await adapter.startThread(process.cwd(), {
          model: 'claude-sonnet-5-5',
          effort: 'ultracode',
          approval: 'full',
          ephemeral: true,
        })
      } finally {
        await adapter.dispose()
      }
      return fake.launches()[0]!.argv
    }
    const sdk = await launch('sdk')
    const cli = await launch('cli')
    const flags = (argv: string[]) =>
      argv
        .filter((arg) => arg !== '-p')
        .map((arg) => arg.replace(/^--session-id=.*/, '--session-id=<new>'))
        .sort()
    expect(flags(cli)).toEqual(flags(sdk))
    expect(cli).toEqual(
      expect.arrayContaining([
        '--model=claude-sonnet-5-5',
        '--effort=xhigh',
        '--settings',
        '{"ultracode":true}',
        '--permission-mode=bypassPermissions',
        '--no-session-persistence',
      ]),
    )
  }, 30_000)

  it('creates a resumed session that claude -p has no transcript for, as through the SDK', async () => {
    const resume = async (runtime: ClaudeRuntime) => {
      const fake = fakeClaude()
      const adapter = new ClaudeCodeAdapter({
        runtime,
        spawn: fake.spawn,
        environment: fake.environment,
      })
      const sessionId = `missing-${crypto.randomUUID()}`
      try {
        await adapter.resumeThread(`claude-${sessionId}`, process.cwd())
      } finally {
        await adapter.dispose()
      }
      return fake
        .launches()
        .map((launch) =>
          launch.argv.find((arg) => arg.startsWith('--resume=') || arg.startsWith('--session-id=')),
        )
    }
    const shapeOf = (flags: Array<string | undefined>) =>
      flags.map((flag) => flag?.replace(/=missing-.*/, '=<id>'))
    const sdk = await resume('sdk')
    const cli = await resume('cli')
    expect(shapeOf(cli)).toEqual(['--resume=<id>', '--session-id=<id>'])
    expect(shapeOf(cli)).toEqual(shapeOf(sdk))
  }, 30_000)

  it('starts claude -p itself, without the SDK entrypoint or the host NODE_OPTIONS', async () => {
    const sdk = await exercise('sdk')
    const cli = await exercise('cli')
    const session = (launches: Launch[]) => launches[0]!

    expect(session(sdk.launches).argv).not.toContain('-p')
    expect(session(sdk.launches).entrypoint).toBe('sdk-ts')
    expect(session(cli.launches).argv.slice(0, 6)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ])
    expect(session(cli.launches).entrypoint).toBeNull()
    for (const launch of [...sdk.launches, ...cli.launches]) expect(launch.nodeOptions).toBeNull()
    // Both runtimes pass the session the same flags after their own.
    const flags = (launch: Launch) =>
      launch.argv
        .filter((arg) => arg !== '-p')
        .map((arg) => arg.replace(/^--session-id=.*/, '--session-id=<new>'))
        .sort()
    expect(flags(session(cli.launches))).toEqual(flags(session(sdk.launches)))
  }, 30_000)

  it('reads plan limits through claude -p when the sessions run through it', async () => {
    const read = async (runtime: ClaudeRuntime) => {
      const fake = fakeClaude()
      const limits = await claudeLimitSource({
        runtime,
        spawn: fake.spawn,
        environment: fake.environment,
      })
      return { limits, launch: fake.launches()[0]! }
    }
    const sdk = await read('sdk')
    const cli = await read('cli')
    expect(cli.limits).toEqual(sdk.limits)
    expect(cli.limits).toMatchObject({ limits: [expect.objectContaining({ usedPercent: 12 })] })
    expect(cli.launch.argv[0]).toBe('-p')
    expect(sdk.launch.argv).not.toContain('-p')
  }, 15_000)
})
