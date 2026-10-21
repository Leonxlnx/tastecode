import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DomainEvent, ProviderId } from '@harness/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import type { AccountDirectory } from './account-directory.js'
import type { AgentSession, ProviderRuntime, SavedSession, StartOptions } from './adapters.js'
import { compactHistoryReplay } from './history-replay.js'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { CONTINUE_CONTEXT_NOTICE, HANDOVER_CONTEXT_NOTICE } from './provider-session.js'
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

type FakeSession = AgentSession & {
  provider: ProviderId
  disposed: boolean
  sent: string[]
  /** Finishes the running turn, with an answer when one is given. */
  finish(answer?: string, status?: 'completed' | 'interrupted' | 'failed'): void
}

type Launch = {
  kind: 'start' | 'resume' | 'fork'
  provider: ProviderId
  workspacePath: string
  options: StartOptions
  threadId?: string
  accountHome?: string | undefined
  from?: SavedSession
}

function setup(
  store = new Store(':memory:'),
  behaviour: {
    failStart?: ProviderId
    promptLimit?: Partial<Record<ProviderId, number>>
    startGate?: Promise<void>
    /** How many times the first session refuses to stop before it does. */
    stopFailures?: number
    /** Context sizes an engine knows per model, as OpenCode lists them. */
    modelWindows?: Partial<Record<ProviderId, Record<string, number>>>
    /** An engine whose model lookup never answers. */
    modelWindowHangs?: ProviderId
    /** Account folders by account id; the default account has none. */
    accountHomes?: Record<string, string>
    /** Engines that carry a saved session on, and whether that fails. */
    forks?: ProviderId[]
    failFork?: boolean
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
      ...(behaviour.modelWindowHangs === provider
        ? { modelContextWindow: () => new Promise<number | undefined>(() => {}) }
        : {}),
      ...(behaviour.modelWindows?.[provider] === undefined
        ? {}
        : {
            modelContextWindow: async (model: string | undefined) =>
              model === undefined ? undefined : behaviour.modelWindows![provider]![model],
          }),
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
        if (sessions[0] === created && (behaviour.stopFailures ?? 0) > 0) {
          behaviour.stopFailures! -= 1
          throw new Error('kill EPERM')
        }
        created.disposed = true
      },
      on: (event: 'event' | 'log', listener: (value: never) => void) => {
        if (event === 'event') listeners.push(listener as (event: DomainEvent) => void)
      },
    }
    sessions.push(created)
    return created
  }
  const runtimeFor = (
    provider: ProviderId,
    _onLog: (line: string) => void,
    accountHome?: string,
  ): ProviderRuntime => ({
    ...(behaviour.forks?.includes(provider)
      ? {
          async fork(workspacePath: string, from: SavedSession, options: StartOptions) {
            launches.push({ kind: 'fork', provider, workspacePath, options, accountHome, from })
            if (behaviour.failFork) throw new Error('no saved conversation to carry on')
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
        }
      : {}),
    async start(workspacePath, options) {
      launches.push({ kind: 'start', provider, workspacePath, options, accountHome })
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
      launches.push({ kind: 'resume', provider, workspacePath, options, threadId, accountHome })
      return {
        thread: { id: threadId, provider, workspacePath, createdAt: Date.now() },
        session: open(provider),
      }
    },
    async listModels() {
      return []
    },
  })
  const accounts: AccountDirectory = {
    home: (_provider, accountId) =>
      accountId === undefined || accountId === 'default'
        ? undefined
        : behaviour.accountHomes?.[accountId],
    active: () => 'default',
  }
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

  it('tries again to stop a session that refuses once, and moves', async () => {
    const repo = repository()
    const { orchestrator, store, sessions } = setup(undefined, { stopFailures: 1 })
    const chat = await orchestrator.startThread('codex', repo)

    await orchestrator.changeProvider(chat.id, { provider: 'claude-code' })

    expect(sessions[0]!.disposed).toBe(true)
    expect(store.thread(chat.id)?.provider).toBe('claude-code')
    await orchestrator.disposeAll()
  })

  it('stays where it is when the session it leaves will not stop', async () => {
    const repo = repository()
    const { orchestrator, store, sessions } = setup(undefined, { stopFailures: 10 })
    const chat = await orchestrator.startThread('codex', repo)

    await expect(orchestrator.changeProvider(chat.id, { provider: 'claude-code' })).rejects.toThrow(
      'The current agent did not stop, so the chat stays where it is: kill EPERM',
    )

    expect(store.thread(chat.id)?.provider).toBe('codex')
    expect(store.threadNeedsHandover(chat.id)).toBe(false)
    // The session it started at the new place is stopped again.
    expect(sessions[1]!.disposed).toBe(true)
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

  it("sizes the handover for the model's own context window when the engine knows it", async () => {
    const repo = repository()
    const { orchestrator, store, sessions } = setup(undefined, {
      modelWindows: { opencode: { 'provider/small-model': 16_000 } },
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
          text: `${index === 0 ? 'FIRST REQUEST ' : ''}${'word '.repeat(4_000)}`,
          createdAt: 1,
        },
      })
    }

    await orchestrator.changeProvider(chat.id, { provider: 'opencode' })
    await orchestrator.sendTurn(chat.id, 'Continue', [], { model: 'provider/small-model' })

    const sent = sessions.at(-1)!.sent[0]!
    const open = sent.indexOf('<earlier_conversation>\n') + '<earlier_conversation>\n'.length
    // Half a character per token of a 16,000-token window.
    expect(sent.indexOf('\n</earlier_conversation>') - open).toBeLessThanOrEqual(8_000)
    expect(sent).toContain('FIRST REQUEST')
    await orchestrator.disposeAll()
  })

  it('does not hold the handover for an engine that cannot say its model window', async () => {
    const repo = repository()
    const { orchestrator, store, sessions } = setup(undefined, { modelWindowHangs: 'opencode' })
    const chat = await orchestrator.startThread('codex', repo)
    store.append(chat.id, {
      type: 'item.completed',
      item: {
        id: 'said',
        turnId: 'old-turn',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Remember ZEBRA-1',
        createdAt: 1,
      },
    })

    await orchestrator.changeProvider(chat.id, { provider: 'opencode' })
    const started = Date.now()
    await orchestrator.sendTurn(chat.id, 'Continue', [], { model: 'provider/model' })

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(sessions.at(-1)!.sent[0]).toContain('ZEBRA-1')
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

describe('another account of the same provider', () => {
  /** A chat on the default Codex account whose first turn is done. */
  async function chatWithAnswer(behaviour: Parameters<typeof setup>[1]) {
    const repo = repository()
    const work = mkdtempSync(path.join(root, 'account-'))
    const setUp = setup(undefined, { accountHomes: { work }, ...behaviour })
    const chat = await setUp.orchestrator.startThread('codex', repo)
    await send(setUp.orchestrator, chat.id, 'Rename the config loader')
    await settle()
    setUp.sessions[0]!.finish('Renamed it in loader.ts.')
    return { ...setUp, repo, work, chat }
  }

  it("moves the chat by carrying the provider's own session on there", async () => {
    const { orchestrator, store, launches, sessions, repo, work, chat } = await chatWithAnswer({
      forks: ['codex'],
    })

    await orchestrator.changeProvider(chat.id, { provider: 'codex', accountId: 'work' })

    expect(launches.at(-1)).toMatchObject({
      kind: 'fork',
      provider: 'codex',
      workspacePath: repo,
      accountHome: work,
    })
    // The chat ran on the default account, whose folder needs no name.
    expect(launches.at(-1)!.from).toEqual({ providerSessionId: chat.id })
    expect(sessions[0]!.disposed).toBe(true)
    expect(store.thread(chat.id)).toMatchObject({
      provider: 'codex',
      accountId: 'work',
      providerSessionId: 'codex-native-2',
    })
    expect(store.threadNeedsHandover(chat.id)).toBe(false)
    expect(store.leftProviderSessions('codex')).toEqual([chat.id])

    await send(orchestrator, chat.id, 'Now update the tests')
    expect(sessions[1]!.sent).toEqual(['Now update the tests'])
    await orchestrator.disposeAll()
  })

  it('hands the conversation over when the provider cannot carry its session on', async () => {
    const { orchestrator, store, launches, sessions, chat } = await chatWithAnswer({
      forks: ['codex'],
      failFork: true,
    })

    await orchestrator.changeProvider(chat.id, { provider: 'codex', accountId: 'work' })

    expect(launches.slice(-2).map((launch) => launch.kind)).toEqual(['fork', 'start'])
    expect(store.threadNeedsHandover(chat.id)).toBe(true)
    await send(orchestrator, chat.id, 'Now update the tests')
    const handover = sessions[1]!.sent[0]!
    expect(handover.startsWith(HANDOVER_CONTEXT_NOTICE)).toBe(true)
    expect(handover).toContain('Renamed it in loader.ts.')
    await orchestrator.disposeAll()
  })

  it('replaces a carried session that fails its first turn by a fresh one with the handover', async () => {
    const { orchestrator, store, launches, sessions, work, chat } = await chatWithAnswer({
      forks: ['codex'],
    })
    await orchestrator.changeProvider(chat.id, { provider: 'codex', accountId: 'work' })
    await send(orchestrator, chat.id, 'Now update the tests')
    await settle()
    // As Codex does when another account's encrypted reasoning cannot be read.
    sessions[1]!.finish(undefined, 'failed')

    await send(orchestrator, chat.id, 'Try again')

    expect(sessions[1]!.disposed).toBe(true)
    expect(launches.at(-1)).toMatchObject({ kind: 'start', provider: 'codex', accountHome: work })
    const handover = sessions[2]!.sent[0]!
    expect(handover.startsWith(HANDOVER_CONTEXT_NOTICE)).toBe(true)
    expect(handover).toContain('Renamed it in loader.ts.')
    expect(withoutContinuationContext(handover)).toBe('Try again')
    expect(store.thread(chat.id)?.providerSessionId).toBe('codex-native-3')
    await orchestrator.disposeAll()
  })

  it('keeps a carried session whose first turn the user stopped', async () => {
    const { orchestrator, store, sessions, chat } = await chatWithAnswer({ forks: ['codex'] })
    await orchestrator.changeProvider(chat.id, { provider: 'codex', accountId: 'work' })
    await send(orchestrator, chat.id, 'Now update the tests')
    await settle()
    sessions[1]!.finish(undefined, 'interrupted')

    await send(orchestrator, chat.id, 'Go on')

    expect(store.threadNeedsHandover(chat.id)).toBe(false)
    expect(sessions[1]!.sent).toEqual(['Now update the tests', 'Go on'])
    await orchestrator.disposeAll()
  })

  it("continues a chat there in a copy of the provider's session", async () => {
    const { orchestrator, launches, sessions, repo, work, chat } = await chatWithAnswer({
      forks: ['codex'],
    })

    const later = await orchestrator.startThread('codex', repo, {
      accountId: 'work',
      continueFrom: chat.id,
    })
    await send(orchestrator, later.id, 'Go on')

    expect(launches.at(-1)).toMatchObject({ kind: 'fork', accountHome: work })
    expect(launches.at(-1)!.from).toEqual({ providerSessionId: chat.id })
    expect(sessions[1]!.sent).toEqual(['Go on'])
    await orchestrator.disposeAll()
  })

  it('continues a chat with its conversation as text when the session cannot be carried on', async () => {
    const { orchestrator, launches, sessions, repo, chat } = await chatWithAnswer({
      forks: ['codex'],
      failFork: true,
    })

    const later = await orchestrator.startThread('codex', repo, {
      accountId: 'work',
      continueFrom: chat.id,
    })
    await send(orchestrator, later.id, 'Go on')

    expect(launches.slice(-2).map((launch) => launch.kind)).toEqual(['fork', 'start'])
    const first = sessions[1]!.sent[0]!
    expect(first.startsWith(CONTINUE_CONTEXT_NOTICE)).toBe(true)
    expect(first).toContain('Renamed it in loader.ts.')
    expect(withoutContinuationContext(first)).toBe('Go on')
    await orchestrator.disposeAll()
  })

  it('does not carry on a session that lacks part of the conversation', async () => {
    const { orchestrator, store, launches, chat } = await chatWithAnswer({ forks: ['codex'] })
    // The chat moved here and has sent nothing since: its session is empty.
    await orchestrator.changeProvider(chat.id, { provider: 'claude-code' })
    await orchestrator.changeProvider(chat.id, { provider: 'codex', accountId: 'work' })

    expect(launches.at(-1)?.kind).toBe('start')
    expect(store.threadNeedsHandover(chat.id)).toBe(true)
    await orchestrator.disposeAll()
  })
})
