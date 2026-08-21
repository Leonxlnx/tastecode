import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  ModelInfo,
  Options,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter, CLAUDE_CAPABILITIES, claudeUserMessage } from './adapter.js'
import type { ClaudeQueryFactory, ClaudeQueryRuntime } from './sdk-runtime.js'

class FakeQuery implements ClaudeQueryRuntime {
  readonly #messages: SDKMessage[] = []
  readonly #waiters: Array<(value: IteratorResult<SDKMessage>) => void> = []
  readonly models: ModelInfo[]
  closed = false
  interrupts = 0
  readonly modelsSet: Array<string | undefined> = []
  readonly permissionModes: string[] = []

  constructor(models: ModelInfo[] = []) {
    this.models = models
  }

  emitMessage(message: SDKMessage): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: message, done: false })
    else this.#messages.push(message)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1
  }

  async setModel(model?: string): Promise<void> {
    this.modelsSet.push(model)
  }

  async setPermissionMode(
    mode: Parameters<ClaudeQueryRuntime['setPermissionMode']>[0],
  ): Promise<void> {
    this.permissionModes.push(mode)
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.models
  }

  async initializationResult(): Promise<SDKControlInitializeResponse> {
    return {
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: [],
      models: this.models,
      account: {},
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift()
        if (message) return Promise.resolve({ value: message, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

function harness(models: ModelInfo[] = []) {
  const inputs: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Options }> = []
  const queries: FakeQuery[] = []
  const createQuery: ClaudeQueryFactory = (input) => {
    inputs.push(input)
    const query = new FakeQuery(models)
    queries.push(query)
    return query
  }
  return { createQuery, inputs, queries }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('Claude Agent SDK session', () => {
  it('declares the controls supplied by the SDK', () => {
    expect(CLAUDE_CAPABILITIES).toMatchObject({
      steer: true,
      interrupt: true,
      approvals: true,
      userInput: true,
      autoReview: true,
      images: true,
    })
  })

  it('keeps one query alive for follow-up turns and applies live model changes', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const thread = await adapter.startThread('/repo', { model: 'opus', effort: 'high' })
    const prompts = fake.inputs[0]!.prompt[Symbol.asyncIterator]()

    await adapter.sendTurn(thread.id, 'First')
    expect((await prompts.next()).value?.message.content).toEqual([{ type: 'text', text: 'First' }])
    fake.queries[0]!.emitMessage(resultMessage(false))
    await tick()

    await adapter.sendTurn(thread.id, 'Second', [], { model: 'sonnet' })
    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0]!.modelsSet).toEqual(['sonnet'])
    expect((await prompts.next()).value?.message.content).toEqual([
      { type: 'text', text: 'Second' },
    ])
    adapter.dispose()
  })

  it('does not persist product-internal background sessions', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    await adapter.startThread('/repo', { ephemeral: true })

    expect(fake.inputs[0]!.options.persistSession).toBe(false)
    adapter.dispose()
  })

  it('resumes through a fresh SDK query when effort changes between turns', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const thread = await adapter.startThread('/repo', { effort: 'low' })
    await adapter.sendTurn(thread.id, 'One')
    fake.queries[0]!.emitMessage(resultMessage(false))
    await tick()

    await adapter.sendTurn(thread.id, 'Think harder', [], { effort: 'high' })
    expect(fake.queries).toHaveLength(2)
    expect(fake.inputs[1]!.options.resume).toBe('session-1')
    expect(fake.inputs[1]!.options.effort).toBe('high')
    adapter.dispose()
  })

  it('streams assistant text through one started/delta/completed lifecycle', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'Answer')
    const query = fake.queries[0]!
    query.emitMessage(
      streamEvent('wire-2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      }),
    )
    query.emitMessage(
      streamEvent('wire-3', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      }),
    )
    query.emitMessage(streamEvent('wire-4', { type: 'content_block_stop', index: 0 }))
    await tick()

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.started' }),
        expect.objectContaining({ type: 'item.delta', textDelta: 'Hello' }),
        expect.objectContaining({
          type: 'item.completed',
          item: expect.objectContaining({ text: 'Hello' }),
        }),
      ]),
    )
    adapter.dispose()
  })

  it('closes unfinished stream blocks before the turn result', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'Answer')
    const query = fake.queries[0]!
    query.emitMessage(
      streamEvent('wire-text', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'partial', citations: null },
      }),
    )
    query.emitMessage(
      streamEvent('wire-tool', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      }),
    )
    query.emitMessage(resultMessage(true))
    await tick()

    const terminal = events.findIndex((event) => event.type === 'turn.completed')
    const completed = events.filter((event) => event.type === 'item.completed')
    expect(completed).toHaveLength(2)
    expect(completed.every((event) => event.item.status === 'failed')).toBe(true)
    expect(events.lastIndexOf(completed[1]!)).toBeLessThan(terminal)
    adapter.dispose()
  })

  it('bridges SDK permission requests to TasteCode approvals', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo', { approval: 'ask' })
    await adapter.sendTurn(thread.id, 'Run it')
    const canUseTool = fake.inputs[0]!.options.canUseTool!
    const pending = canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
        title: 'Claude wants to run npm test',
      },
    )
    const request = events.find((event) => event.type === 'approval.requested')
    expect(request).toMatchObject({
      type: 'approval.requested',
      request: { kind: 'command', command: 'npm test', reason: 'Claude wants to run npm test' },
    })
    if (request?.type !== 'approval.requested') throw new Error('approval request missing')
    adapter.respondToApproval(request.request.id, 'approve')
    await expect(pending).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      toolUseID: 'tool-1',
    })
    adapter.dispose()
  })

  it('round-trips AskUserQuestion answers using the question text as Claude expects', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'Choose')
    const pending = fake.inputs[0]!.options.canUseTool!(
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Framework',
            question: 'Which framework?',
            options: [{ label: 'React', description: 'Use React' }],
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: 'ask-1' },
    )
    const request = events.find((event) => event.type === 'user_input.requested')
    expect(request).toMatchObject({
      type: 'user_input.requested',
      request: { questions: [{ id: 'Which framework?', question: 'Which framework?' }] },
    })
    if (request?.type !== 'user_input.requested') throw new Error('question request missing')
    adapter.respondToUserInput(request.request.id, { 'Which framework?': ['React'] })
    await expect(pending).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which framework?': 'React' } },
    })
    adapter.dispose()
  })

  it('uses SDK control calls for interruption and permission-mode changes', async () => {
    const fake = harness()
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'Work')
    await adapter.setApproval('full')
    await adapter.interrupt()
    expect(fake.queries[0]!.permissionModes).toEqual(['bypassPermissions'])
    expect(fake.queries[0]!.interrupts).toBe(1)
    adapter.dispose()
  })

  it('drops the synthetic default, deduplicates context aliases, and keeps the catalog', async () => {
    const fake = harness([
      {
        value: 'default',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Default (recommended)',
        description: 'Account default',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Opus (1M context)',
        description: 'Opus 5 with 1M context',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'claude-fable-5[1m]',
        resolvedModel: 'claude-fable-5',
        displayName: 'Fable',
        description: 'Fable 5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: 'Sonnet 5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku',
        description: 'Haiku 4.5',
      },
    ])
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const models = await adapter.listModels()
    expect(
      models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        isDefault: model.isDefault,
      })),
    ).toEqual([
      { id: 'claude-fable-5[1m]', displayName: 'Claude Fable 5', isDefault: false },
      { id: 'opus[1m]', displayName: 'Claude Opus 5', isDefault: true },
      { id: 'sonnet', displayName: 'Claude Sonnet 5', isDefault: false },
      { id: 'haiku', displayName: 'Claude Haiku 4.5', isDefault: false },
      { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', isDefault: false },
      { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', isDefault: false },
      { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', isDefault: false },
      { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', isDefault: false },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', isDefault: false },
    ])
    expect(models.some((model) => model.id === 'default')).toBe(false)
    expect(models.filter((model) => model.displayName.includes('1M context'))).toEqual([])
    expect(models.filter((model) => model.isDefault)).toHaveLength(1)
    expect(fake.inputs[0]!.options.persistSession).toBe(false)
    adapter.dispose()
  })
})

describe('Claude SDK user messages', () => {
  it('keeps long unicode and multiline prompts in the SDK message body', () => {
    const text = ` Grüße 🧪\n${'x'.repeat(40_000)}`
    expect(claudeUserMessage(text).message).toEqual({
      role: 'user',
      content: [{ type: 'text', text }],
    })
  })

  it('embeds images and keeps other selected files readable by path', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-claude-attachment-'))
    try {
      const image = path.join(directory, 'sample.png')
      const document = path.join(directory, 'notes.txt')
      writeFileSync(image, 'image bytes')
      writeFileSync(document, 'notes')
      expect(claudeUserMessage('Describe these.', [image, document]).message.content).toEqual([
        {
          type: 'text',
          text: `Describe these.\n\nAttached file paths:\n- ${JSON.stringify(document)}`,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from('image bytes').toString('base64'),
          },
        },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function streamEvent(
  uuid: string,
  event: SDKPartialAssistantMessage['event'],
): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event,
    uuid,
    session_id: 'session-1',
    parent_tool_use_id: null,
  }
}

function resultMessage(isError: boolean): SDKMessage {
  // SAFETY: This captured result fixture contains every field read by the adapter;
  // the SDK's expanding NonNullableUsage contract adds unrelated telemetry fields.
  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: isError ? ['failed'] : undefined,
    result: isError ? undefined : 'ok',
    uuid: crypto.randomUUID(),
    session_id: 'session-1',
  } as SDKMessage
}
