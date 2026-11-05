import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './adapter.js'

// #2190: Codex 0.164 answered a Design chat's resume with "no rollout found for thread id …".
// A thread's rollout is written with its first turn, so this thread never completed one.
const provider = String.raw`
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result = {};
  if (method === 'thread/resume') {
    if (params.threadId === 'unsaved-thread') {
      process.stdout.write(JSON.stringify({ id, error: { code: -32600,
        message: 'no rollout found for thread id ' + params.threadId } }) + '\n');
      return;
    }
    if (params.threadId === 'broken-thread') {
      process.stdout.write(JSON.stringify({ id, error: { code: -32603,
        message: 'thread is locked by another writer' } }) + '\n');
      return;
    }
    result = { thread: { id: params.threadId, createdAt: 1700000000 }, model: 'gpt-6-luna' };
  }
  if (method === 'thread/start') {
    result = { thread: { id: 'fresh-thread', createdAt: 1700000100 }, model: 'gpt-6-luna' };
  }
  if (method === 'turn/start') result = { turn: { id: 'first-turn' } };
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
});
`

function adapter(): CodexAdapter {
  return new CodexAdapter({ spawn: () => spawn(process.execPath, ['-e', provider]) })
}

describe('Codex resume of a thread without a rollout', () => {
  it('starts a fresh thread, reports its id, and continues the chat on it', async () => {
    const codex = adapter()
    const logs: string[] = []
    codex.on('log', (line: string) => logs.push(line))
    try {
      await codex.start()
      const thread = await codex.resumeThread('unsaved-thread', process.cwd())
      expect(thread.id).toBe('fresh-thread')
      const reported: string[] = []
      codex.onProviderSessionId((id) => reported.push(id))
      expect(reported).toEqual(['fresh-thread'])
      expect(logs.some((line) => line.includes('starting a new Codex thread'))).toBe(true)
      await expect(codex.sendTurn(thread.id, 'Build the page')).resolves.toBe('first-turn')
    } finally {
      await codex.dispose()
    }
  })

  it('keeps every other resume failure', async () => {
    const codex = adapter()
    const reported: string[] = []
    codex.onProviderSessionId((id) => reported.push(id))
    try {
      await codex.start()
      await expect(codex.resumeThread('broken-thread', process.cwd())).rejects.toThrow(
        'thread is locked by another writer',
      )
      await expect(codex.resumeThread('saved-thread', process.cwd())).resolves.toMatchObject({
        id: 'saved-thread',
      })
      expect(reported).toEqual([])
    } finally {
      await codex.dispose()
    }
  })
})
