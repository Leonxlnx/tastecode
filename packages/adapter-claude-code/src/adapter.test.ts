import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  ClaudeCodeAdapter,
  CLAUDE_CAPABILITIES,
  CLAUDE_MODELS,
  claudeTurnArgs,
  claudeUserMessage,
  parseClaudeEfforts,
} from './adapter.js'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  kill(): boolean {
    setImmediate(() => this.emit('exit', null))
    return true
  }
}

describe('Claude Code turn invocation', () => {
  it('keeps every argv element newline-free (#372: cmd.exe truncates there)', () => {
    const args = claudeTurnArgs(
      { model: 'haiku', approval: 'ask', instructions: 'line one\nline two\n- bullet' },
      'session-1',
      'C:\\tmp\\harness-claude-abc\\system-prompt.md',
    )
    for (const arg of args) {
      expect(arg).not.toMatch(/[\r\n]/)
    }
  })

  it('never carries the prompt or instructions text on argv', () => {
    const instructions = 'Write like a clear, capable teammate.\n- Lead with the answer.'
    const args = claudeTurnArgs({ instructions }, undefined, '/tmp/x/system-prompt.md')
    expect(args.join(' ')).not.toContain('teammate')
    expect(args).toContain('--input-format')
    expect(args).toContain('--append-system-prompt-file')
  })

  it('keeps --resume so the conversation survives the turn boundary', () => {
    const args = claudeTurnArgs({ model: 'haiku' }, 'sess-9', undefined)
    expect(args.slice(-2)).toEqual(['--resume', 'sess-9'])
    expect(args).not.toContain('--append-system-prompt-file')
  })

  it('passes the selected effort and omits the flag when none is chosen', () => {
    const withEffort = claudeTurnArgs({ model: 'opus', effort: 'xhigh' }, undefined, undefined)
    expect(withEffort).toContain('--effort')
    expect(withEffort[withEffort.indexOf('--effort') + 1]).toBe('xhigh')
    const withoutEffort = claudeTurnArgs({ model: 'opus' }, undefined, undefined)
    expect(withoutEffort).not.toContain('--effort')
  })

  it('applies a changed model and effort to the next CLI invocation', async () => {
    let args: string[] = []
    const adapter = new ClaudeCodeAdapter({
      spawn: (_command, value) => {
        args = value
        return new FakeChild() as unknown as ChildProcessWithoutNullStreams
      },
    })
    const thread = await adapter.startThread('C:\\repo', { model: 'opus', effort: 'low' })

    await adapter.sendTurn(thread.id, 'Think again', [], { model: 'sonnet', effort: 'xhigh' })

    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'sonnet',
    ])
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual([
      '--effort',
      'xhigh',
    ])

    await adapter.sendTurn(thread.id, 'Use the fast model', [], {
      model: 'haiku',
      effort: undefined,
    })
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'haiku',
    ])
    expect(args).not.toContain('--effort')
    adapter.dispose()
  })

  it('mirrors the documented per-model effort table', () => {
    const byId = new Map(CLAUDE_MODELS.map((model) => [model.id, model]))
    expect(byId.get('fable')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(byId.get('fable')?.defaultReasoningEffort).toBe('high')
    expect(byId.get('claude-opus-4-7')?.defaultReasoningEffort).toBe('xhigh')
    expect(byId.get('claude-opus-4-6')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(byId.get('claude-sonnet-4-6')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])
    expect(byId.get('haiku')?.reasoningEfforts).toEqual([])
  })

  it('intersects the model table with effort values published by the installed CLI', async () => {
    const help =
      '  --effort <level>  Effort level for the current session\n' +
      '                    (low, medium, high, max)\n'
    expect(parseClaudeEfforts(help)).toEqual(['low', 'medium', 'high', 'max'])
    const models = await new ClaudeCodeAdapter({
      run: async () => ({ code: 0, stdout: help }),
    }).listModels()
    expect(models.find((model) => model.id === 'fable')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])
    expect(models.find((model) => model.id === 'claude-opus-4-7')?.defaultReasoningEffort).toBe(
      'high',
    )
  })

  it('encodes long unicode and multiline prompts as one stream-json stdin line', () => {
    const text = ` Grüße 🧪\n${'x'.repeat(40_000)}`
    const line = claudeUserMessage(text)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/)
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
  })

  it('encodes images and keeps other selected files readable by path', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-claude-attachment-'))
    try {
      const image = path.join(directory, 'sample.png')
      const document = path.join(directory, 'notes.txt')
      writeFileSync(image, 'image bytes')
      writeFileSync(document, 'notes')

      expect(JSON.parse(claudeUserMessage('Describe these.', [image, document]))).toEqual({
        type: 'user',
        message: {
          role: 'user',
          content: [
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
          ],
        },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('declares image support after the stream-json wire is verified', () => {
    expect(CLAUDE_CAPABILITIES.images).toBe(true)
  })
})

describe('Claude Code model list', () => {
  it('offers the documented --model aliases under full versioned names', async () => {
    const adapter = new ClaudeCodeAdapter({
      run: async () => ({ code: 0, stdout: '--effort <level> (low, medium, high, xhigh, max)' }),
    })
    expect(await adapter.listModels()).toMatchObject([
      { id: 'fable', displayName: 'Fable 5', isDefault: true },
      { id: 'opus', displayName: 'Opus 5' },
      { id: 'sonnet', displayName: 'Sonnet 5' },
      { id: 'haiku', displayName: 'Haiku 4.5' },
      { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { id: 'claude-opus-4-7', displayName: 'Opus 4.7' },
      { id: 'claude-opus-4-6', displayName: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    ])
  })

  it('uses a concrete named model as the default', () => {
    expect(CLAUDE_MODELS.filter((model) => model.isDefault).map((model) => model.id)).toEqual([
      'fable',
    ])
    expect(CLAUDE_MODELS.some((model) => model.id === 'default')).toBe(false)
  })
})
