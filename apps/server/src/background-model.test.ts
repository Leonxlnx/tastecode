import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type {
  BackgroundModelPreference,
  Capabilities,
  DomainEvent,
  Model,
} from '@harness/contracts'
import type { AgentSession, ProviderRuntime, StartOptions, TurnOptions } from './adapters.js'
import {
  cleanGeneratedCommitMessage,
  cleanGeneratedTitle,
  commitMessagePrompt,
  resolveBackgroundModel,
  runBackgroundCompletion,
  type AvailableBackgroundModelSource,
} from './background-model.js'

const model = (id: string, reasoningEfforts: string[] = [], isDefault = false): Model => ({
  id,
  displayName: id,
  isDefault,
  reasoningEfforts,
  serviceTiers: [],
})

describe('background model resolution', () => {
  it.each([
    ['priority', 'priority'],
    ['standard', 'standard'],
    ['unsupported', undefined],
    [undefined, undefined],
  ])('resolves the supported speed %s as %s', (requested, expected) => {
    const resolved = resolveBackgroundModel(
      {
        mode: 'manual',
        target: { provider: 'codex', model: 'gpt-5.6-luna', serviceTier: requested },
      },
      [
        {
          id: 'codex',
          displayName: 'Codex',
          provider: 'codex',
          models: [
            {
              ...model('gpt-5.6-luna', ['low']),
              serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
              defaultServiceTier: 'standard',
            },
          ],
        },
      ],
    )
    expect(resolved?.serviceTier).toBe(expected)
  })

  it('prefers Luna low for a ChatGPT-authenticated Codex source', () => {
    const sources: AvailableBackgroundModelSource[] = [
      {
        id: 'codex',
        displayName: 'Codex',
        provider: 'codex',
        codexSubscription: true,
        models: [model('gpt-5.6-luna', ['low', 'medium', 'high'])],
      },
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        provider: 'claude-code',
        models: [model('claude-haiku-4-5', ['low'])],
      },
      {
        id: 'grok',
        displayName: 'Grok',
        provider: 'grok',
        models: [model('grok-4.6', ['low', 'high'])],
      },
    ]

    expect(resolveBackgroundModel({ mode: 'automatic' }, sources)).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'low',
      sourceName: 'Codex',
      automatic: true,
    })
  })

  it('prefers Grok 4.6 at low without a Codex subscription', () => {
    const sources: AvailableBackgroundModelSource[] = [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        provider: 'claude-code',
        models: [model('claude-haiku-4-5', ['minimal', 'low'])],
      },
      {
        id: 'grok',
        displayName: 'Grok',
        provider: 'grok',
        models: [
          model('grok-4.5', ['low', 'medium', 'high'], true),
          model('grok-4.6', ['low', 'medium', 'high', 'xhigh']),
        ],
      },
    ]

    expect(resolveBackgroundModel({ mode: 'automatic' }, sources)).toEqual({
      provider: 'grok',
      model: 'grok-4.6',
      effort: 'low',
      sourceName: 'Grok',
      automatic: true,
    })
  })

  it('chooses the newest cost-oriented model and its lowest effort without Codex subscription', () => {
    const sources: AvailableBackgroundModelSource[] = [
      {
        id: 'codex',
        displayName: 'Codex API',
        provider: 'codex',
        codexSubscription: false,
        models: [model('gpt-5.6-pro', ['low', 'high'], true)],
      },
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        provider: 'claude-code',
        models: [
          model('claude-sonnet-5', ['low', 'high'], true),
          model('claude-haiku-3-5', ['low', 'high']),
          model('claude-haiku-4-5', ['minimal', 'low', 'high']),
        ],
      },
    ]

    expect(resolveBackgroundModel({ mode: 'automatic' }, sources)).toMatchObject({
      provider: 'claude-code',
      model: 'claude-haiku-4-5',
      effort: 'minimal',
      automatic: true,
    })
  })

  it('honors a manual source, model, and effort', () => {
    const preference: BackgroundModelPreference = {
      mode: 'manual',
      target: { provider: 'grok', model: 'grok-code-fast-1', effort: 'high' },
    }
    const sources: AvailableBackgroundModelSource[] = [
      {
        id: 'grok',
        displayName: 'Grok',
        provider: 'grok',
        models: [model('grok-code-fast-1', ['low', 'high'])],
      },
    ]

    expect(resolveBackgroundModel(preference, sources)).toMatchObject({
      provider: 'grok',
      model: 'grok-code-fast-1',
      effort: 'high',
      automatic: false,
    })
  })
})

describe('background completion', () => {
  it.each([undefined, 'priority', 'standard'])(
    'passes speed %s to the session and turn, and disposes the temporary session',
    async (serviceTier) => {
      const session = new CompletingSession()
      let startOptions: StartOptions | undefined
      const runtime: ProviderRuntime = {
        async start(workspacePath, options) {
          startOptions = options
          return {
            thread: {
              id: 'background-thread',
              provider: 'codex',
              workspacePath,
              createdAt: 0,
            },
            session,
          }
        },
        async listModels() {
          return []
        },
      }

      await expect(
        runBackgroundCompletion({
          runtime,
          selection: {
            provider: 'codex',
            model: 'gpt-5.6-luna',
            effort: 'low',
            serviceTier,
            sourceName: 'Codex',
            automatic: true,
          },
          prompt: 'Write a title.',
        }),
      ).resolves.toBe('Generated title')
      expect(startOptions).toMatchObject({
        model: 'gpt-5.6-luna',
        effort: 'low',
        approval: 'ask',
        ephemeral: true,
      })
      expect(session.disposed).toBe(true)
      expect(startOptions?.serviceTier).toBe(serviceTier)
      expect(session.turnOptions?.serviceTier).toBe(serviceTier)
    },
  )

  it('hands the live session to its owner before the turn runs', async () => {
    const session = new CompletingSession()
    const owned: AgentSession[] = []
    const runtime: ProviderRuntime = {
      async start(workspacePath) {
        return {
          thread: {
            id: 'background-thread',
            provider: 'codex',
            workspacePath,
            createdAt: 0,
          },
          session,
        }
      },
      async listModels() {
        return []
      },
    }

    await expect(
      runBackgroundCompletion({
        runtime,
        selection: {
          provider: 'codex',
          model: 'gpt-5.6-luna',
          sourceName: 'Codex',
          automatic: true,
        },
        prompt: 'Write a title.',
        onSession: (started) => owned.push(started),
      }),
    ).resolves.toBe('Generated title')
    expect(owned).toEqual([session])
  })
})

describe('background output shaping', () => {
  it('removes fences and title decoration', () => {
    expect(cleanGeneratedTitle('```text\nTitle: Fix queue ordering.\n```', 'Fallback')).toBe(
      'Fix queue ordering',
    )
    expect(cleanGeneratedCommitMessage('```\nfix(queue): preserve order\n```')).toBe(
      'fix(queue): preserve order',
    )
  })

  it('renders a bounded structured diff for commit-message drafting', () => {
    const prompt = commitMessagePrompt({
      threadId: 'workspace',
      version: 'tree',
      files: [
        {
          path: 'src/queue.ts',
          status: 'modified',
          binary: false,
          hunks: [
            {
              id: 'h1',
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'deletion', oldLine: 1, text: 'old' },
                { kind: 'addition', newLine: 1, text: 'new' },
              ],
            },
          ],
        },
      ],
    })

    expect(prompt).toContain('FILE modified src/queue.ts')
    expect(prompt).toContain('-old\n+new')
  })
})

const CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
}

class CompletingSession implements AgentSession {
  readonly capabilities = CAPABILITIES
  disposed = false
  turnOptions: TurnOptions | undefined
  #events = new EventEmitter()

  async sendTurn(
    _threadId: string,
    _text: string,
    _attachments: string[],
    options?: TurnOptions,
  ): Promise<string> {
    this.turnOptions = options
    queueMicrotask(() => {
      this.#emit({
        type: 'item.completed',
        item: {
          id: 'answer',
          turnId: 'background-turn',
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          text: 'Generated title',
          createdAt: 0,
        },
      })
      this.#emit({ type: 'turn.completed', turnId: 'background-turn', status: 'completed' })
    })
    return 'background-turn'
  }

  async interrupt(): Promise<void> {}
  respondToApproval(): void {}
  dispose(): void {
    this.disposed = true
  }
  on(event: 'event' | 'log', listener: (value: never) => void): void {
    this.#events.on(event, listener)
  }
  #emit(event: DomainEvent): void {
    this.#events.emit('event', event)
  }
}
