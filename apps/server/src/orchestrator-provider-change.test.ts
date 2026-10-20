import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DomainEvent, ProviderId } from '@harness/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import type { AccountDirectory } from './account-directory.js'
import type { AgentSession, ProviderRuntime, StartOptions } from './adapters.js'
import { compactHistoryReplay } from './history-replay.js'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { HANDOVER_CONTEXT_NOTICE } from './provider-session.js'
import { withoutContinuationContext } from './side-chat.js'
import { Store } from './store.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'harness-provider-change-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function repository(): string {
  const repo = mkdtempSync(path.join(root, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'loader.ts'), 'export const loader = 1\n')
  git('add', 'loader.ts')
  git('commit', '-m', 'initial')
  return repo
}

const accounts: AccountDirectory = { home: () => undefined, active: () => 'default' }

type FakeSession = AgentSession & {
  provider: ProviderId
  disposed: boolean
  sent: string[]
  /** Finishes the running turn, with an answer when one is given. */
  finish(answer?: string, status?: 'completed' | 'interrupted' | 'failed'): void
}

type Launch = {
  kind: 'start' | 'resume'
  provider: ProviderId
  workspacePath: string
  options: StartOptions
  threadId?: string
}

function setup(
  store = new Store(':memory:'),
  behaviour: {
    failStart?: ProviderId
    promptLimit?: Partial<Record<ProviderId, number>>
    startGate?: Promise<void>
  } = {},
) {
  const launches: Launch[] = []
  const sessions: FakeSession[] = []
  let opened = 0
  const open = (provider: ProviderId): FakeSession => {
    const listeners: Array<(event: DomainEvent) => void> = []
    let running: string | undefined
    const emit = (event: DomainEvent) => {
      for (const listener of listeners) listener(event)
    }
    const created: FakeSession = {
      provider,
      disposed: false,
      sent: [],
      capabilities: {
        steer: false,
        fork: false,
        interrupt: true,
        reasoningItems: false,
        approvals: false,
        images: false,
      },
      ...(behaviour.promptLimit?.[provider] === undefined
        ? {}
        : { promptLimit: behaviour.promptLimit[provider] }),
      sendTurn: async (threadId, text) => {
        created.sent.push(text)
        running = `${provider}-turn-${created.sent.length}`
        const turnId = running
        setImmediate(() =>
          emit({
            type: 'turn.started',
            turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
          }),
        )
        return turnId
      },
      finish: (answer, status = 'completed') => {
        const turnId = running!
        if (answer !== undefined) {
          emit({
            type: 'item.completed',
            item: {
              id: `${turnId}-answer`,
              turnId,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              text: answer,
              createdAt: Date.now(),
            },
          })
        }
        emit({ type: 'turn.completed', turnId, status })
        running = undefined
      },
      interrupt: async () => {},
      respondToApproval: () => {},
      dispose: () => {
        created.disposed = true
      },
      on: (event: 'event' | 'log', listener: (value: never) => void) => {
        if (event === 'event') listeners.push(listener as (event: DomainEvent) => void)
      },
    }
    sessions.push(created)
    return created
  }
  const runtimeFor = (provider: ProviderId): ProviderRuntime => ({
    async start(workspacePath, options) {
      launches.push({ kind: 'start', provider, workspacePath, options })
      await behaviour.startGate
      if (behaviour.failStart === provider) throw new Error(`${provider} is not signed in`)
      opened += 1
      return {
        thread: {
          id: `${provider}-native-${opened}`,
          provider,
          workspacePath,
          createdAt: Date.now(),
        },
        session: open(provider),
      }
    },
    async resume(threadId, workspacePath, options) {
      launches.push({ kind: 'resume', provider, workspacePath, options, threadId })
      return {
        thread: { id: threadId, provider, workspacePath, createdAt: Date.now() },
        session: open(provider),
      }
    },
    async listModels() {
      return []
    },
  })
  const orchestrator = new Orchestrator(store, {
    onEvent: () => {},
    onLog: () => {},
    runtimeFor,
    accounts,
    mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
    worktreeRoot: path.join(root, 'trees'),
  })
  return { orchestrator, store, launches, sessions }
}

/** Sends as the renderer does, so the transcript records the user's words. */
const send = (orchestrator: Orchestrator, threadId: string, text: string) =>
  orchestrator.submitTurn(threadId, text, [], {}, crypto.randomUUID())

/** Lets the fake's turn.started reach the orchestrator. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

function transcript(store: Store, threadId: string) {
  return compactHistoryReplay(store.history(threadId)).flatMap(({ event }) =>
    event.type === 'item.completed' ? [event.item] : [],
  )
}

describe('moving a chat to another provider', () => {
  it('keeps the chat and hands its conversation to the next prompt there', async () => {
    const repo = repository()
    const { orchestrator, store, launches, sessions } = setup()
    const chat = await orchestrator.startThread('codex', repo, { approval: 'auto' })
    await send(orchestrator, chat.id, 'Rename the config loader')
    await settle()
    sessions[0]!.finish('Renamed it in loader.ts.')
    writeFileSync(path.join(repo, 'loader.ts'), 'export const configLoader = 1\n')

    await orchestrator.changeProvider(chat.id, { provider: 'claude-code', model: 'sonnet' })

    expect(sessions[0]!.disposed).toBe(true)
    expect(launches.at(-1)).toMatchObject({
      kind: 'start',
      provider: 'claude-code',
      workspacePath: repo,
      options: { model: 'sonnet', approval: 'auto' },
    })
    expect(store.thread(chat.id)).toMatchObject({
      id: chat.id,
      provider: 'claude-code',
      providerSessionId: 'claude-code-native-2',
    })
    expect(store.leftProviderSessions('codex')).toEqual([chat.id])
    expect(transcript(store, chat.id).at(-1)).toMatchObject({
      type: 'notice',
      turnId: '',
      notice: { kind: 'provider', provider: 'claude-code', model: 'sonnet' },
    })

    await send(orchestrator, chat.id, 'Now update the tests')
    const handover = sessions[1]!.sent[0]!
    expect(sessions[0]!.sent).toEqual(['Rename the config loader'])
    expect(handover.startsWith(HANDOVER_CONTEXT_NOTICE)).toBe(true)
    expect(handover).toContain('Rename the config loader')
    expect(handover).toContain('Renamed it in loader.ts.')
    expect(handover).toContain('"kind":"moved","provider":"claude-code","model":"sonnet"')
    expect(handover).toContain('"kind":"workspace","branch":"main","changes":["M loader.ts"]')
    expect(handover.endsWith('User request:\nNow update the tests')).toBe(true)
    expect(withoutContinuationContext(handover)).toBe('Now update the tests')
    // The transcript keeps the user's words; the request appears once.
    const users = transcript(store, chat.id).filter((item) => item.role === 'user')
    expect(users.map((item) => item.text)).toEqual([
      'Rename the config loader',
      'Now update the tests',
    ])
    expect(handover.match(/Now update the tests/g)).toHaveLength(1)

    await settle()
    sessions[1]!.finish('Updated.')
    await send(orchestrator, chat.id, 'Thanks')
    expect(sessions[1]!.sent[1]).toBe('Thanks')
    await orchestrator.disposeAll()
  })

  it('leaves the chat where it was when the new provider does not start', async () => {
    const repo = repository()
    const { orchestrator, store, sessions } = setup(undefined, { failStart: 'cursor' })
    const chat = await orchestrator.startThread('codex', repo)

    await expect(orchestrator.changeProvider(chat.id, { provider: 'cursor' })).rejects.toThrow(
      'cursor is not signed in',
    )

    expect(store.thread(chat.id)?.provider).toBe('codex')
    expect(store.threadNeedsHandover(chat.id)).toBe(false)
    expect(sessions[0]!.disposed).toBe(false)
    expect(transcript(store, chat.id)).toEqual([])
    await send(orchestrator, chat.id, 'Still here')
    expect(sessions[0]!.sent).toEqual(['Still here'])
    await orchestrator.disposeAll()
  })

  it('refuses to move while work is under way, a Side chat, or to where it runs', async () => {
    const repo = repository()
    const { orchestrator, sessions } = setup()
    const chat = await orchestrator.startThread('codex', repo)
    await send(orchestrator, chat.id, 'Long task')
    await settle()

    await expect(orchestrator.changeProvider(chat.id, { provider: 'claude-code' })).rejects.toThrow(
      'Wait for the current turn to finish',
    )
    sessions[0]!.finish('Done.')
    await expect(orchestrator.changeProvider(chat.id, { provider: 'codex' })).rejects.toThrow(
      'already runs there',
    )
    await expect(orchestrator.changeProvider(chat.id, { provider: 'api' })).rejects.toThrow(
      'API connection',
    )
    const side = await orchestrator.startSideThread(chat.id)
    await expect(orchestrator.changeProvider(side.id, { provider: 'claude-code' })).rejects.toThrow(
      'Side chat',
    )
    await orchestrator.disposeAll()
  })

  it('refuses a prompt while the chat is moving', async () => {
    const repo = repository()
    let open!: () => void
    const startGate = new Promise<void>((resolve) => (open = resolve))
    const first = setup()
    const chat = await first.orchestrator.startThread('codex', repo)
    await first.orchestrator.disposeAll()
    const { orchestrator } = setup(first.store, { startGate })

    const moving = orchestrator.changeProvider(chat.id, { provider: 'claude-code' })
    await settle()
    await expect(orchestrator.submitTurn(chat.id, 'Too early')).rejects.toThrow(
      'moving to another provider',
    )
    open()
    await moving
    await orchestrator.disposeAll()
  })

  it('starts afresh after a restart that came before the first prompt there', async () => {
    const repo = repository()
    const first = setup()
    const chat = await first.orchestrator.startThread('codex', repo)
    await send(first.orchestrator, chat.id, 'Rename the config loader')
    await settle()
    first.sessions[0]!.finish('Renamed.')
    await first.orchestrator.changeProvider(chat.id, { provider: 'grok' })
    await first.orchestrator.disposeAll()

    const second = setup(first.store)
    await send(second.orchestrator, chat.id, 'Go on')

    // Grok creates its native session only at the first turn, so resuming
    // one that never ran would fail; nothing is lost by starting again.
    expect(second.launches.map(({ kind, provider }) => [kind, provider])).toEqual([
      ['start', 'grok'],
    ])
    const sent = second.sessions[0]!.sent[0]!
    expect(sent.startsWith(HANDOVER_CONTEXT_NOTICE)).toBe(true)
    expect(sent).toContain('Rename the config loader')
    expect(second.store.thread(chat.id)?.providerSessionId).toBe('grok-native-1')
    expect(second.store.leftProviderSessions('grok')).toEqual(['grok-native-2'])
    expect(second.store.threadNeedsHandover(chat.id)).toBe(false)
    await second.orchestrator.disposeAll()

    // Once it has run there, the chat resumes that session again.
    const third = setup(second.store)
    await third.orchestrator.setThreadApproval(chat.id, 'ask')
    expect(third.launches).toMatchObject([
      { kind: 'resume', provider: 'grok', options: { providerSessionId: 'grok-native-1' } },
    ])
    await third.orchestrator.disposeAll()
  })

  it('carries the handover again when the first turn there ends before any answer', async () => {
    const repo = repository()
    const { orchestrator, sessions } = setup()
    const chat = await orchestrator.startThread('codex', repo)
    await send(orchestrator, chat.id, 'Rename the config loader')
    await settle()
    sessions[0]!.finish('Renamed.')
    await orchestrator.changeProvider(chat.id, { provider: 'cursor' })

    // The CLI could not start, so the turn failed before the agent read anything.
    await send(orchestrator, chat.id, 'Go on')
    await settle()
    sessions[1]!.finish(undefined, 'failed')
    await send(orchestrator, chat.id, 'Go on, please')
    expect(sessions[1]!.sent[1]!.startsWith(HANDOVER_CONTEXT_NOTICE)).toBe(true)
    expect(sessions[1]!.sent[1]).toContain('Rename the config loader')
    expect(sessions[1]!.sent[1]!.endsWith('User request:\nGo on, please')).toBe(true)

    // This time the agent answered before the turn failed: it has the context.
    await settle()
    sessions[1]!.finish('Partly done.', 'failed')
    await send(orchestrator, chat.id, 'Finish it')
    expect(sessions[1]!.sent[2]).toBe('Finish it')
    await orchestrator.disposeAll()
  })

  it('fits the handover into an engine that limits its prompt', async () => {
    const repo = repository()
    const { orchestrator, store, sessions } = setup(undefined, {
      promptLimit: { cursor: 14_000 },
    })
    const chat = await orchestrator.startThread('codex', repo)
    for (let index = 0; index < 6; index += 1) {
      store.append(chat.id, {
        type: 'item.completed',
        item: {
          id: `said-${index}`,
          turnId: 'old-turn',
          type: 'message',
          role: index % 2 ? 'assistant' : 'user',
          status: 'completed',
          text: `${index === 0 ? 'FIRST REQUEST ' : ''}${'"quoted" '.repeat(2_000)}`,
          createdAt: 1,
        },
      })
    }

    await orchestrator.changeProvider(chat.id, { provider: 'cursor' })
    await send(orchestrator, chat.id, 'Continue')

    const sent = sessions.at(-1)!.sent[0]!
    expect(sent.length).toBeLessThanOrEqual(14_000)
    expect(sent).toContain('FIRST REQUEST')
    expect(sent.endsWith('User request:\nContinue')).toBe(true)
    await orchestrator.disposeAll()
  })
})
