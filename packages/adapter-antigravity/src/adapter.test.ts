import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { DomainEvent, McpServerConfig } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  AntigravityAdapter,
  ANTIGRAVITY_CAPABILITIES,
  antigravityModeForApproval,
  parseAntigravityModels,
} from './adapter.js'
import { resetAntigravityIndexForTests } from './models.js'

/** Captured initialize and session/new config options from agy acp 1.5.14. */
const AGY_INIT_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
  },
  agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' },
}

const AGY_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-4-neon',
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ],
  },
]

type RpcFrame = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown }

class FakeAgyAcpChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdin = new PassThrough()
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ]
  readonly requests: RpcFrame[] = []
  #buffer = ''

  constructor(private readonly onPrompt?: (child: FakeAgyAcpChild, frame: RpcFrame) => void) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.#buffer += chunk
      let nl: number
      while ((nl = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, nl).trim()
        this.#buffer = this.#buffer.slice(nl + 1)
        if (!line) continue
        const frame = JSON.parse(line) as RpcFrame
        this.requests.push(frame)
        this.#handle(frame)
      }
    })
  }

  send(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  #handle(frame: RpcFrame): void {
    if (frame.id === undefined) return
    switch (frame.method) {
      case 'initialize':
        this.send({ jsonrpc: '2.0', id: frame.id, result: AGY_INIT_RESULT })
        return
      case 'session/new':
        this.send({
          jsonrpc: '2.0',
          id: frame.id,
          result: { sessionId: 'agy-sess-1', configOptions: AGY_CONFIG_OPTIONS },
        })
        return
      case 'session/load':
        this.send({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: AGY_CONFIG_OPTIONS },
        })
        return
      case 'session/set_config_option':
        this.send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: AGY_CONFIG_OPTIONS } })
        return
      case 'session/prompt':
        if (this.onPrompt) {
          this.onPrompt(this, frame)
          return
        }
        this.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'agy-sess-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'MOND' },
            },
          },
        })
        this.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'agy-sess-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'LICHT' },
            },
          },
        })
        this.send({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            stopReason: 'end_turn',
            usage: { inputTokens: 100, outputTokens: 12, thoughtTokens: 4, totalTokens: 116 },
          },
        })
        return
      default:
        this.send({ jsonrpc: '2.0', id: frame.id, result: {} })
    }
  }

  override kill(): boolean {
    setImmediate(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', 0, null)
      this.emit('close', 0)
    })
    return true
  }
}

describe('Antigravity ACP adapter', () => {
  it('declares ACP capabilities for approvals, reasoning items and native images', () => {
    expect(ANTIGRAVITY_CAPABILITIES).toEqual({
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: true,
      approvals: true,
      images: true,
      imageFiles: true,
    })
  })

  it('maps approval modes onto agy acp mode options', () => {
    const modes = ['default', 'accept-edits', 'auto', 'plan']
    expect(antigravityModeForApproval('ask', modes)).toBe('default')
    expect(antigravityModeForApproval('auto', modes)).toBe('accept-edits')
    expect(antigravityModeForApproval('full', modes)).toBe('auto')
    expect(antigravityModeForApproval('auto', ['default'])).toBeUndefined()
  })

  it('starts agy acp, passes HTTP MCP servers directly, applies config options, and streams a turn', async () => {
    resetAntigravityIndexForTests()
    parseAntigravityModels(
      [
        'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
        'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      ].join('\n'),
    )

    const spawned: Array<{ command: string; args: string[] }> = []
    let acpChild: FakeAgyAcpChild | undefined
    const mcpServers: McpServerConfig[] = [
      {
        id: 'tastecode',
        enabled: true,
        transport: {
          type: 'http',
          url: 'http://127.0.0.1:4444/agents/abc',
          headers: { Authorization: { source: 'credential', credentialRef: 'tc-token' } },
        },
      },
    ]

    const adapter = new AntigravityAdapter({
      spawn: ((command: string, args: string[]) => {
        spawned.push({ command, args })
        acpChild = new FakeAgyAcpChild()
        return acpChild
      }) as never,
      mcpServers,
      mcpCredentials: { 'tc-token': 'Bearer secret-token' },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))

    const thread = await adapter.startThread('C:\\repo', {
      model: 'gemini-3.8-flash-high',
      effort: 'low',
      approval: 'auto',
      instructions: 'Be concise.',
    })
    expect(thread.id).toBe('acp-antigravity-agy-sess-1')
    expect(thread.provider).toBe('antigravity')
    expect(spawned).toEqual([expect.objectContaining({ args: ['acp'] })])

    const sessionNew = acpChild!.requests.find((r) => r.method === 'session/new')
    expect(sessionNew?.params).toEqual({
      cwd: 'C:\\repo',
      mcpServers: [
        {
          type: 'http',
          name: 'tastecode',
          url: 'http://127.0.0.1:4444/agents/abc',
          headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
        },
      ],
    })

    const configCalls = acpChild!.requests.filter((r) => r.method === 'session/set_config_option')
    expect(configCalls.map((call) => call.params)).toEqual([
      { sessionId: 'agy-sess-1', configId: 'model', value: 'gemini-3.8-flash-low' },
      { sessionId: 'agy-sess-1', configId: 'thought_level', value: 'low' },
      { sessionId: 'agy-sess-1', configId: 'mode', value: 'accept-edits' },
    ])

    const turnDone = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })
    await adapter.sendTurn(thread.id, 'Say MONDLICHT')
    await turnDone

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: 'LICHT' }),
        expect.objectContaining({
          type: 'item.completed',
          item: expect.objectContaining({ type: 'message', text: 'MONDLICHT' }),
        }),
        expect.objectContaining({
          type: 'usage.updated',
          usage: expect.objectContaining({
            inputTokens: 100,
            outputTokens: 16,
            reasoningTokens: 4,
            totalTokens: 116,
          }),
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )
    await adapter.dispose()
  })

  it('resumes ACP sessions via session/load and marks legacy print-mode threads missing', async () => {
    let acpChild: FakeAgyAcpChild | undefined
    const adapter = new AntigravityAdapter({
      spawn: (() => {
        acpChild = new FakeAgyAcpChild()
        return acpChild
      }) as never,
    })

    await expect(
      adapter.resumeThread('antigravity-legacy-uuid', 'C:\\repo'),
    ).rejects.toMatchObject({ code: 'provider_session_missing' })

    const resumed = await adapter.resumeThread('acp-antigravity-agy-sess-1', 'C:\\repo', {
      approval: 'ask',
    })
    expect(resumed.id).toBe('acp-antigravity-agy-sess-1')
    expect(acpChild!.requests.some((r) => r.method === 'session/load')).toBe(true)
    await adapter.dispose()
  })

  it('rejects automatic approval review', async () => {
    const adapter = new AntigravityAdapter()
    await expect(adapter.startThread('C:\\repo', { approval: 'auto-review' })).rejects.toThrow(
      'automatic approval review',
    )
  })

  it('parses agy models output and collapses per-effort variants', () => {
    resetAntigravityIndexForTests()
    const models = parseAntigravityModels(
      [
        'Fetching available models...',
        'gemini-4-neon-high\tGemini 4 Neon (High)',
        'gemini-4-neon-low\tGemini 4 Neon (Low)',
        'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
      ].join('\n'),
    )
    expect(models).toEqual([
      expect.objectContaining({
        id: 'gemini-4-neon-high',
        displayName: 'Gemini 4 Neon',
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
      }),
      expect.objectContaining({
        id: 'gpt-oss-120b-medium',
        displayName: 'GPT-OSS 120B',
        description: 'Fixed at medium effort',
        reasoningEfforts: [],
      }),
    ])
  })
})
