import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter, CLAUDE_MODELS, claudeTurnArgs, claudeUserMessage } from './adapter.js'

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

  it('mirrors the documented per-model effort table', () => {
    const byId = new Map(CLAUDE_MODELS.map((model) => [model.id, model]))
    expect(byId.get('fable')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(byId.get('fable')?.defaultReasoningEffort).toBe('high')
    expect(byId.get('claude-opus-4-7')?.defaultReasoningEffort).toBe('xhigh')
    expect(byId.get('claude-sonnet-4-6')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])
    expect(byId.get('haiku')?.reasoningEfforts).toEqual([])
  })

  it('encodes the prompt as one stream-json user message line', () => {
    const line = claudeUserMessage('first line\nsecond line')
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'first line\nsecond line' }] },
    })
  })
})

describe('Claude Code model list', () => {
  it('offers the documented --model aliases under full versioned names', async () => {
    const adapter = new ClaudeCodeAdapter()
    expect(await adapter.listModels()).toMatchObject([
      { id: 'fable', displayName: 'Fable 5', isDefault: true },
      { id: 'opus', displayName: 'Opus 5' },
      { id: 'sonnet', displayName: 'Sonnet 5' },
      { id: 'haiku', displayName: 'Haiku 4.5' },
      { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { id: 'claude-opus-4-7', displayName: 'Opus 4.7' },
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    ])
  })

  it('marks exactly one model as the default', () => {
    expect(CLAUDE_MODELS.filter((model) => model.isDefault)).toHaveLength(1)
  })
})
