import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PiAdapter } from './adapter.js'

const PiCommandSchema = z.object({
  id: z.string(),
  type: z.string(),
  message: z.string().optional(),
  provider: z.string().optional(),
  modelId: z.string().optional(),
  level: z.string().optional(),
})
type PiCommand = z.infer<typeof PiCommandSchema>

class FakeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ]

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null))
    return true
  }
}

function attachRpc(child: FakeChild): PiCommand[] {
  let buffered = ''
  const commands: PiCommand[] = []
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk: string) => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const command = PiCommandSchema.parse(JSON.parse(buffered.slice(0, newline)))
      commands.push(command)
      buffered = buffered.slice(newline + 1)
      const data =
        command.type === 'get_state'
          ? {
              sessionId: 'session-1',
              model: { provider: 'openrouter', id: 'deepseek-v3.2' },
              thinkingLevel: 'high',
            }
          : command.type === 'get_available_models'
            ? {
                models: [
                  {
                    provider: 'openrouter',
                    id: 'deepseek-v3.2',
                    name: 'DeepSeek V3.2',
                    reasoning: true,
                  },
                ],
              }
            : command.type === 'get_available_thinking_levels'
              ? { levels: ['low', 'high'] }
              : {}
      child.stdout.write(
        `${JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data })}\n`,
      )
      if (command.type === 'prompt') {
        child.stdout.write(
          [
            {
              type: 'message_update',
              assistantMessageEvent: { type: 'thinking_delta', delta: 'Considering' },
            },
            {
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'Checking' },
            },
            {
              type: 'message_end',
              message: {
                stopReason: 'toolUse',
                usage: { input: 12, cacheRead: 3, output: 4, totalTokens: 19 },
              },
            },
            {
              type: 'tool_execution_start',
              toolCallId: 'tool-1',
              toolName: 'bash',
              args: { command: 'pwd' },
            },
            {
              type: 'tool_execution_end',
              toolCallId: 'tool-1',
              result: { content: [{ text: '/repo' }] },
            },
            {
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'Done' },
            },
            { type: 'message_end', message: { stopReason: 'stop' } },
            { type: 'agent_end', willRetry: false },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n') + '\n',
        )
      }
    }
  })
  return commands
}

describe('Pi adapter', () => {
  it('launches a custom executable in RPC mode and maps streamed events', async () => {
    const child = new FakeChild()
    attachRpc(child)
    let launch: { command: string; args: string[]; cwd?: string } | undefined
    const adapter = new PiAdapter({
      command: 'deepseek-pi',
      args: ['--profile', 'work tree'],
      displayName: 'DeepSeek Pi',
      spawn: (command, args, options) => {
        launch = { command, args, cwd: options.cwd }
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))

    const thread = await adapter.startThread('/repo', {
      model: 'openrouter/deepseek-v3.2',
      effort: 'high',
      instructions: 'Be concise.',
    })
    await adapter.sendTurn(thread.id, 'Hello')
    await new Promise((resolve) => setImmediate(resolve))

    expect(launch).toEqual({
      command: 'deepseek-pi',
      args: ['--profile', 'work tree', '--mode', 'rpc'],
      cwd: '/repo',
    })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: 'Considering' }),
        expect.objectContaining({ type: 'item.delta', textDelta: 'Done' }),
        expect.objectContaining({
          type: 'item.completed',
          item: expect.objectContaining({ type: 'message', text: 'Done' }),
        }),
        expect.objectContaining({
          type: 'usage.updated',
          usage: expect.objectContaining({
            inputTokens: 12,
            cachedInputTokens: 3,
            outputTokens: 4,
          }),
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )
    const messages = events.filter(
      (event) => event.type === 'item.completed' && event.item.type === 'message',
    )
    expect(messages).toHaveLength(2)
    expect(
      new Set(messages.map((event) => (event.type === 'item.completed' ? event.item.id : ''))).size,
    ).toBe(2)
    adapter.dispose()
  })

  it('discovers fork-specific models and thinking levels', async () => {
    const child = new FakeChild()
    const commands = attachRpc(child)
    let launchArgs: string[] = []
    const adapter = new PiAdapter({
      command: '/opt/pi/bin/pi',
      spawn: (_command, args) => {
        launchArgs = args
        return child
      },
    })

    await expect(adapter.listModels()).resolves.toEqual([
      {
        id: 'openrouter/deepseek-v3.2',
        displayName: 'DeepSeek V3.2',
        description: 'openrouter',
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
      },
    ])
    expect(launchArgs).toEqual(['--no-session', '--mode', 'rpc'])
    expect(commands.slice(-2)).toEqual([
      expect.objectContaining({
        type: 'set_model',
        provider: 'openrouter',
        modelId: 'deepseek-v3.2',
      }),
      expect.objectContaining({ type: 'set_thinking_level', level: 'high' }),
    ])
    adapter.dispose()
  })
})
