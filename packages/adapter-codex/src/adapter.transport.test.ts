import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './adapter.js'

describe('Codex history transport', () => {
  it('resumes a history larger than 16 MiB and accepts the next turn', async () => {
    // The local wire capture returned 18.29 MiB for thread/read. The resume
    // response carries the same history, although TasteCode only needs identity.
    const peer = `
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).on('line', line => {
        const { id, method, params } = JSON.parse(line);
        if (id === undefined) return;
        let result = {};
        if (method === 'thread/resume') result = {
          thread: { id: params.threadId, createdAt: 1700000000,
            turns: [{ items: [{ type: 'agentMessage', text: 'x'.repeat(19 * 1024 * 1024) }] }] },
          model: 'test-model'
        };
        if (method === 'turn/start') result = { turn: { id: 'next-turn' } };
        process.stdout.write(JSON.stringify({ id, result }) + '\\n');
      });
    `
    const adapter = new CodexAdapter({
      spawn: () =>
        spawn(process.execPath, ['-e', peer], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }),
    })
    try {
      await adapter.start()
      await expect(adapter.resumeThread('long-history', process.cwd())).resolves.toMatchObject({
        id: 'long-history',
      })
      await expect(adapter.sendTurn('long-history', 'Continue')).resolves.toBe('next-turn')
    } finally {
      await adapter.dispose()
    }
  })
})
