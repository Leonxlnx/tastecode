import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './adapter.js'

// #2190: Codex 0.164 answered a chat's resume with "no rollout found for thread id …". The
// thread may never have completed a turn, or its rollout lives in another account's folder or
// was moved; only the server knows, so the adapter reports the missing session and stops there.
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
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
});
`

function adapter(): CodexAdapter {
  return new CodexAdapter({ spawn: () => spawn(process.execPath, ['-e', provider]) })
}

describe('Codex resume of a thread without a rollout', () => {
  it('reports the missing session with its code and starts nothing', async () => {
    const codex = adapter()
    try {
      await codex.start()
      const resuming = codex.resumeThread('unsaved-thread', process.cwd())
      await expect(resuming).rejects.toThrow('no rollout found for thread id unsaved-thread')
      await expect(resuming).rejects.toMatchObject({ code: 'provider_session_missing' })
    } finally {
      await codex.dispose()
    }
  })

  it('keeps every other resume failure as it was', async () => {
    const codex = adapter()
    try {
      await codex.start()
      const broken = codex.resumeThread('broken-thread', process.cwd())
      await expect(broken).rejects.toThrow('thread is locked by another writer')
      await expect(broken).rejects.not.toMatchObject({ code: 'provider_session_missing' })
      await expect(codex.resumeThread('saved-thread', process.cwd())).resolves.toMatchObject({
        id: 'saved-thread',
      })
    } finally {
      await codex.dispose()
    }
  })
})
