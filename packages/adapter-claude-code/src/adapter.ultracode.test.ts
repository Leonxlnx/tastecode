import { readFileSync } from 'node:fs'
import type {
  McpServerStatus,
  ModelInfo,
  Options,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter, claudeEffortOptions } from './adapter.js'
import type { ClaudeQueryFactory, ClaudeQueryRuntime } from './sdk-runtime.js'

/** Captured from claude 2.1.296 through the Agent SDK without sending a prompt. */
const capture = JSON.parse(
  readFileSync(new URL('./fixtures/ultracode-claude-2.1.296.json', import.meta.url), 'utf8'),
) as {
  supportedModels: ModelInfo[]
  getSettingsApplied: Record<
    'discovery' | 'opusUltracode' | 'haikuUltracode' | 'opus46Ultracode',
    Record<string, unknown>
  >
}

class FakeQuery implements ClaudeQueryRuntime {
  readonly #models: ModelInfo[]
  #closed = false
  #wake: (() => void) | undefined
  getSettings?: () => Promise<unknown>

  constructor(models: ModelInfo[], applied: Record<string, unknown> | undefined) {
    this.#models = models
    if (applied) this.getSettings = async () => ({ effective: {}, sources: [], applied })
  }

  close(): void {
    this.#closed = true
    this.#wake?.()
  }

  async interrupt() {
    return undefined
  }

  async setModel(): Promise<void> {}

  async setPermissionMode(): Promise<void> {}

  async supportedModels(): Promise<ModelInfo[]> {
    return this.#models
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return []
  }

  async setMcpServers() {
    return { added: [], removed: [], errors: {} }
  }

  async initializationResult(): Promise<SDKControlInitializeResponse> {
    return {
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: [],
      models: this.#models,
      account: {},
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        if (!this.#closed) await new Promise<void>((resolve) => (this.#wake = resolve))
        return { value: undefined, done: true }
      },
    }
  }
}

function harness(applied: Record<string, unknown> | undefined) {
  const inputs: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Options }> = []
  const createQuery: ClaudeQueryFactory = (input) => {
    inputs.push(input)
    return new FakeQuery(capture.supportedModels, applied)
  }
  return { createQuery, inputs }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('Claude Ultracode effort level', () => {
  it('maps the Ultracode level to the flag setting its own --effort alias resolves to', () => {
    expect(claudeEffortOptions('ultracode')).toEqual({
      effort: 'xhigh',
      settings: { ultracode: true },
    })
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(claudeEffortOptions(effort)).toEqual({ effort })
    }
    expect(claudeEffortOptions(undefined)).toEqual({})
    expect(() => claudeEffortOptions('ultra')).toThrow()
  })

  it('offers Ultracode last on xhigh models while the runtime reports it available', async () => {
    const fake = harness(capture.getSettingsApplied.discovery)
    const models = await new ClaudeCodeAdapter({ createQuery: fake.createQuery }).listModels()
    const efforts = (id: string) => models.find((model) => model.id === id)?.reasoningEfforts

    for (const id of ['opus', 'sonnet', 'haiku', 'claude-fable-5-1[1m]', 'claude-opus-4-7']) {
      expect(efforts(id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    }
    // Claude Code reports Ultracode unavailable on a model without xhigh.
    expect(capture.getSettingsApplied.opus46Ultracode).toMatchObject({ ultracodeAvailable: false })
    expect(efforts('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(efforts('claude-haiku-4-5')).toEqual([])
    expect(fake.inputs[0]!.options).not.toHaveProperty('settings')
  })

  it.each([
    [
      'dynamic workflows are off',
      { ...capture.getSettingsApplied.discovery, ultracodeAvailable: false },
    ],
    ['the runtime cannot report settings', undefined],
  ])('does not offer Ultracode when %s', async (_case, applied) => {
    const fake = harness(applied)
    const models = await new ClaudeCodeAdapter({ createQuery: fake.createQuery }).listModels()
    expect(models.some((model) => model.reasoningEfforts.includes('ultracode'))).toBe(false)
    expect(models.find((model) => model.id === 'opus')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('starts an Ultracode session at xhigh with the ultracode setting', async () => {
    const fake = harness(capture.getSettingsApplied.opusUltracode)
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    try {
      await adapter.startThread('/repo', { model: 'claude-opus-5-5', effort: 'ultracode' })
      expect(fake.inputs[0]!.options).toMatchObject({
        model: 'claude-opus-5-5',
        effort: 'xhigh',
        settings: { ultracode: true },
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('restarts the session when the level moves between Max and Ultracode', async () => {
    const fake = harness(capture.getSettingsApplied.opusUltracode)
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    try {
      const thread = await adapter.startThread('/repo', { effort: 'max' })
      expect(fake.inputs[0]!.options.effort).toBe('max')
      expect(fake.inputs[0]!.options).not.toHaveProperty('settings')

      await adapter.sendTurn(thread.id, 'Plan the refactor', [], { effort: 'ultracode' })
      expect(fake.inputs).toHaveLength(2)
      expect(fake.inputs[1]!.options).toMatchObject({
        effort: 'xhigh',
        settings: { ultracode: true },
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('logs when Claude Code declines Ultracode for the session', async () => {
    const fake = harness(capture.getSettingsApplied.opus46Ultracode)
    const adapter = new ClaudeCodeAdapter({ createQuery: fake.createQuery })
    const logs: string[] = []
    adapter.on('log', (line) => logs.push(line))
    try {
      await adapter.startThread('/repo', { model: 'claude-opus-4-6', effort: 'ultracode' })
      await tick()
      expect(logs).toContain('Claude Code did not turn Ultracode on for this session')
    } finally {
      await adapter.dispose()
    }
  })
})
