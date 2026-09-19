import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './adapter.js'

// Use the real stdio transport so a full-history reply crosses its 16 MiB cap.
const provider = String.raw`
const { createInterface } = require('node:readline');
let experimentalApi = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result = {};
  if (method === 'initialize') experimentalApi = params.capabilities?.experimentalApi === true;
  if (method === 'thread/resume') {
    // Captured from Codex 0.146.0: this field is gated by the initialize handshake.
    if (params.excludeTurns && !experimentalApi) {
      process.stdout.write(JSON.stringify({ id, error: { code: -32600,
        message: 'thread/resume.excludeTurns requires experimentalApi capability' } }) + '\n');
      return;
    }
    result = {
      thread: {
        id: params.threadId,
        createdAt: 1700000000,
        turns: params.excludeTurns ? [] : Array.from({ length: 128 }, (_, i) => ({
          id: String(i),
          items: [{ type: 'agentMessage', text: 'x'.repeat(140 * 1024) }],
        })),
      },
      model: 'gpt-5.6',
    };
  }
  if (method === 'turn/start') result = { turn: { id: 'next-turn' } };
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
});
`

function longHistoryAdapter(): CodexAdapter {
  return new CodexAdapter({
    spawn: () => spawn(process.execPath, ['-e', provider]),
  })
}

describe('Codex long-history resume', () => {
  it('resumes and continues a chat whose full history exceeds the frame limit', async () => {
    const adapter = longHistoryAdapter()
    try {
      await adapter.start()
      const thread = await adapter.resumeThread('long-thread', process.cwd())
      expect(thread.id).toBe('long-thread')
      expect(thread.createdAt).toBe(1_700_000_000_000)
      await expect(adapter.sendTurn(thread.id, 'Continue')).resolves.toBe('next-turn')
      // A later resume must stay small too, after the chat has been used again.
      await expect(adapter.resumeThread(thread.id, process.cwd())).resolves.toEqual(thread)
    } finally {
      await adapter.dispose()
    }
  })

  it('reloads MCP settings without fetching the long chat history', async () => {
    const adapter = longHistoryAdapter()
    try {
      await adapter.start()
      await expect(adapter.reloadMcpServers('long-thread', [], {})).resolves.toBeUndefined()
      await expect(adapter.sendTurn('long-thread', 'Continue')).resolves.toBe('next-turn')
    } finally {
      await adapter.dispose()
    }
  })
})
