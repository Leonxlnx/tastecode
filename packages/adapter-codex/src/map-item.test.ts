import { describe, expect, it } from 'vitest'
import type { ThreadItem } from './generated/v2/ThreadItem.js'
import { CodexThreadItemSchema, mapThreadItem } from './map-item.js'

const context = { turnId: 'turn-1', status: 'completed', createdAt: 10 } as const

/** Sanitized lifecycle item captured from Codex 0.147.0 on Windows. */
const capturedImageView = {
  type: 'imageView',
  id: 'exec-e4010f67-cbbb-4f18-8e4b-aa4baf3a2d3c',
  path: 'D:\\project\\qa\\desktop.png',
} satisfies ThreadItem

function collab(overrides: Partial<Extract<ThreadItem, { type: 'collabAgentToolCall' }>> = {}) {
  return {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'parent',
    receiverThreadIds: ['child-1'],
    prompt: 'Audit the reducer',
    model: null,
    reasoningEffort: null,
    agentsStates: { 'child-1': { status: 'running', message: null } },
    ...overrides,
  } satisfies ThreadItem
}

describe('Codex collaboration items', () => {
  it('keeps an in-progress spawn visibly running', () => {
    expect(mapThreadItem(collab({ status: 'inProgress' }), context)).toMatchObject({
      type: 'tool_call',
      status: 'started',
      text: 'Spawning a subagent\nAudit the reducer',
    })
  })

  it('maps a parallel spawn to one readable provider-neutral activity', () => {
    expect(
      mapThreadItem(
        collab({
          receiverThreadIds: ['child-1', 'child-2'],
          agentsStates: {
            'child-1': { status: 'running', message: null },
            'child-2': { status: 'pendingInit', message: null },
          },
        }),
        context,
      ),
    ).toMatchObject({
      id: 'collab-1',
      type: 'tool_call',
      status: 'completed',
      text: 'Spawned 2 subagents\nAudit the reducer',
    })
  })

  it('surfaces failed child state even when the wait call itself completed', () => {
    expect(
      mapThreadItem(
        collab({
          tool: 'wait',
          receiverThreadIds: ['child-1', 'child-2'],
          agentsStates: {
            'child-1': { status: 'completed', message: 'done' },
            'child-2': { status: 'errored', message: 'process exited' },
          },
        }),
        context,
      ),
    ).toMatchObject({
      type: 'tool_call',
      status: 'failed',
      text: '1 of 2 subagents failed\nAudit the reducer',
    })
  })

  it('maps legacy subagent activity without exposing a raw provider type', () => {
    expect(
      mapThreadItem(
        {
          type: 'subAgentActivity',
          id: 'activity-1',
          kind: 'interrupted',
          agentThreadId: 'child-1',
          agentPath: 'child-1',
        },
        context,
      ),
    ).toMatchObject({ type: 'tool_call', status: 'failed', text: 'Subagent interrupted' })
  })
})

describe('Codex assistant messages', () => {
  it.each(['commentary', 'final_answer'] as const)('preserves the %s phase', (phase) => {
    expect(
      mapThreadItem(
        {
          type: 'agentMessage',
          id: `message-${phase}`,
          text: 'Provider-authored text',
          phase,
          memoryCitation: null,
        },
        context,
      ),
    ).toMatchObject({ type: 'message', role: 'assistant', phase })
  })
})

describe('Codex image inspection items', () => {
  it('maps the captured lifecycle to one stable provider-neutral activity', () => {
    const started = mapThreadItem(capturedImageView, { ...context, status: 'started' })
    const completed = mapThreadItem(capturedImageView, context)

    expect(started).toMatchObject({
      id: capturedImageView.id,
      type: 'tool_call',
      status: 'started',
      text: 'image view\ndesktop.png',
    })
    expect(completed).toMatchObject({
      id: capturedImageView.id,
      type: 'tool_call',
      status: 'completed',
      text: 'image view\ndesktop.png',
    })
    expect(completed.text).not.toContain('D:\\project')
  })

  it('keeps sequential views distinct and ordered', () => {
    const items = [
      capturedImageView,
      { ...capturedImageView, id: 'exec-image-2', path: '/project/qa/mobile.png' },
    ].map((item) => mapThreadItem(item, context))

    expect(items.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: capturedImageView.id, text: 'image view\ndesktop.png' },
      { id: 'exec-image-2', text: 'image view\nmobile.png' },
    ])
  })

  it('preserves a failed lifecycle without claiming the image was viewed', () => {
    expect(mapThreadItem(capturedImageView, { ...context, status: 'failed' })).toMatchObject({
      type: 'tool_call',
      status: 'failed',
      text: 'image view\ndesktop.png',
    })
  })
})

describe('Codex context compaction items', () => {
  it('maps context compaction to a provider-neutral tool activity', () => {
    expect(
      mapThreadItem(
        { type: 'contextCompaction', id: 'compaction-1' },
        { ...context, status: 'started' },
      ),
    ).toMatchObject({
      id: 'compaction-1',
      type: 'tool_call',
      status: 'started',
      text: 'context compaction',
    })
  })
})

describe('Codex activity items', () => {
  it.each([
    [
      {
        type: 'hookPrompt',
        id: 'hook-1',
        fragments: [{ text: 'Check the changed files', hookRunId: 'run-1' }],
      },
      'hook prompt',
    ],
    [{ type: 'sleep', id: 'sleep-1', durationMs: 1_000 }, 'sleep'],
    [
      {
        type: 'imageGeneration',
        id: 'image-1',
        status: 'completed',
        revisedPrompt: null,
        result: 'image bytes omitted',
      },
      'image generation',
    ],
    [
      { type: 'enteredReviewMode', id: 'review-in', review: 'Review the change' },
      'enter review mode',
    ],
    [{ type: 'exitedReviewMode', id: 'review-out', review: 'Review complete' }, 'exit review mode'],
    [{ type: 'contextCompaction', id: 'compact-1' }, 'context compaction'],
  ] satisfies Array<[ThreadItem, string]>)('maps $type to a named tool activity', (raw, text) => {
    expect(mapThreadItem(raw, context)).toMatchObject({
      id: raw.id,
      type: 'tool_call',
      text,
    })
  })

  it('keeps the duration for tools that report one', () => {
    expect(
      mapThreadItem(
        {
          type: 'dynamicToolCall',
          id: 'dynamic-1',
          namespace: 'workspace',
          tool: 'inspect',
          arguments: {},
          status: 'completed',
          contentItems: null,
          success: true,
          durationMs: 240,
        },
        context,
      ),
    ).toMatchObject({ type: 'tool_call', text: 'inspect', durationMs: 240 })
  })

  it('carries dynamic tool arguments and output as the transcript text convention', () => {
    const raw = CodexThreadItemSchema.parse({
      type: 'dynamicToolCall',
      id: 'dynamic-2',
      namespace: null,
      tool: 'cua_repl.js',
      arguments: { code: 'await page.screenshot({ path: "home.png" })' },
      status: 'completed',
      contentItems: [
        { type: 'inputText', text: 'Saved home.png' },
        { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
      ],
      success: true,
      durationMs: 900,
    })

    expect(mapThreadItem(raw, context)).toMatchObject({
      type: 'tool_call',
      status: 'completed',
      text: [
        'cua_repl.js',
        '{"code":"await page.screenshot({ path: \\"home.png\\" })"}',
        'Saved home.png\n[image]',
      ].join('\n'),
    })
    expect(
      mapThreadItem({ ...raw, success: false, contentItems: null } as typeof raw, context),
    ).toMatchObject({
      status: 'failed',
      text: 'cua_repl.js\n{"code":"await page.screenshot({ path: \\"home.png\\" })"}',
    })
  })

  it('writes inline MCP images, audio and file blobs as placeholders', () => {
    const data = 'iVBORw0KGgo'.repeat(10_000)
    const raw = CodexThreadItemSchema.parse({
      type: 'mcpToolCall',
      id: 'mcp-2',
      server: 'node_repl',
      tool: 'js',
      status: 'completed',
      arguments: { code: 'await cropImage()' },
      appContext: null,
      pluginId: null,
      result: {
        content: [
          { type: 'text', text: 'Cropped' },
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'audio', data, mimeType: 'audio/wav' },
          { type: 'resource', resource: { uri: 'file:///tmp/frame.bin', blob: data } },
          { type: 'resource_link', uri: 'file:///tmp/notes.md', name: 'notes' },
        ],
        structuredContent: null,
        _meta: null,
      },
      error: null,
      durationMs: 10,
    })

    expect(mapThreadItem(raw, context)).toMatchObject({
      type: 'tool_call',
      text: [
        'node_repl.js',
        '{"code":"await cropImage()"}',
        'Cropped',
        '[image]',
        '[audio]',
        '[file file:///tmp/frame.bin]',
        '{"type":"resource_link","uri":"file:///tmp/notes.md","name":"notes"}',
      ].join('\n'),
    })
  })

  it('carries MCP tool arguments, result text and errors', () => {
    const raw = CodexThreadItemSchema.parse({
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'github',
      tool: 'search_issues',
      status: 'completed',
      arguments: { query: 'is:open label:bug' },
      appContext: null,
      pluginId: null,
      result: {
        content: [{ type: 'text', text: '3 issues' }],
        structuredContent: null,
        _meta: null,
      },
      error: null,
      durationMs: 1_200,
    })

    expect(mapThreadItem(raw, context)).toMatchObject({
      type: 'tool_call',
      status: 'completed',
      text: 'github.search_issues\n{"query":"is:open label:bug"}\n3 issues',
      durationMs: 1_200,
    })
    expect(
      mapThreadItem(
        {
          ...raw,
          status: 'failed',
          result: null,
          error: { message: 'rate limited' },
        } as typeof raw,
        context,
      ),
    ).toMatchObject({
      status: 'failed',
      text: 'github.search_issues\n{"query":"is:open label:bug"}\nrate limited',
    })
  })

  it('keeps the web search query', () => {
    expect(
      mapThreadItem(
        CodexThreadItemSchema.parse({
          type: 'webSearch',
          id: 'search-1',
          query: 'vite hmr css',
          action: null,
        }),
        context,
      ),
    ).toMatchObject({ type: 'tool_call', text: 'web search\n{"query":"vite hmr css"}' })
  })

  it('renders a patch as one unified diff with per-file headers and line counts', () => {
    const raw = CodexThreadItemSchema.parse({
      type: 'fileChange',
      id: 'patch-1',
      status: 'completed',
      changes: [
        {
          path: 'src/style.css',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,2 +1,2 @@\n-a{color:red}\n+a{color:blue}\n b{}\n',
        },
        {
          path: 'src/new.js',
          kind: { type: 'add' },
          diff: '@@ -0,0 +1,2 @@\n+export const x = 1\n+export const y = 2\n',
        },
      ],
    })

    const item = mapThreadItem(raw, context)
    expect(item).toMatchObject({
      type: 'file_change',
      status: 'completed',
      path: 'src/style.css',
      linesAdded: 3,
      linesRemoved: 1,
    })
    expect(item.text).toBe(
      [
        'diff --git a/src/style.css b/src/style.css',
        '--- a/src/style.css',
        '+++ b/src/style.css',
        '@@ -1,2 +1,2 @@',
        '-a{color:red}',
        '+a{color:blue}',
        ' b{}',
        'diff --git a/src/new.js b/src/new.js',
        '--- /dev/null',
        '+++ b/src/new.js',
        '@@ -0,0 +1,2 @@',
        '+export const x = 1',
        '+export const y = 2',
      ].join('\n'),
    )
    expect(mapThreadItem({ ...raw, status: 'declined' } as typeof raw, context)).toMatchObject({
      status: 'failed',
    })
  })

  it('reports a failed or declined command as failed, but never before it finished', () => {
    const raw = CodexThreadItemSchema.parse({
      type: 'commandExecution',
      id: 'command-2',
      command: 'rm -rf build',
      status: 'declined',
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    })

    expect(mapThreadItem(raw, context)).toMatchObject({ type: 'command', status: 'failed' })
    expect(mapThreadItem(raw, { ...context, status: 'started' })).toMatchObject({
      status: 'started',
    })
    expect(
      mapThreadItem({ ...raw, status: 'completed', exitCode: 0 } as typeof raw, context),
    ).toMatchObject({ status: 'completed', exitCode: 0 })
  })

  it('preserves valid empty and zero command results', () => {
    const item = CodexThreadItemSchema.parse({
      type: 'commandExecution',
      id: 'command-1',
      command: 'true',
      aggregatedOutput: '',
      exitCode: 0,
      durationMs: 0,
    })

    expect(mapThreadItem(item, context)).toMatchObject({
      type: 'command',
      text: '',
      exitCode: 0,
      durationMs: 0,
    })
  })

  it('keeps future provider items visible without accepting malformed known items', () => {
    const future = CodexThreadItemSchema.parse({
      type: 'futureActivity',
      id: 'future-1',
      providerOnlyField: true,
    })

    expect(mapThreadItem(future, context)).toMatchObject({
      id: 'future-1',
      type: 'unknown',
      text: '[futureActivity]',
    })
    expect(() =>
      CodexThreadItemSchema.parse({ type: 'commandExecution', id: 'broken-command' }),
    ).toThrow()
  })
})
