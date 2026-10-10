import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCodexHistorySource } from '@harness/adapter-codex'
import { reverseUnifiedDiff } from './diff-review.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

it('undoes an imported Codex turn that edited a file twice, created and deleted files', async () => {
  const repo = temp('codex-undo-repo-')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(path.join(repo, 'f.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(repo, 'g.txt'), 'x\ny\nz\n')
  writeFileSync(path.join(repo, 'old.txt'), 'gone\n')
  git('add', '.')
  git('commit', '-m', 'base')
  writeFileSync(path.join(repo, 'f.txt'), 'one\n2\nthree\n')
  writeFileSync(path.join(repo, 'g.txt'), 'x\nY\nz\n')
  writeFileSync(path.join(repo, 'new.txt'), 'fresh\n')
  writeFileSync(path.join(repo, '__init__.py'), '')
  rmSync(path.join(repo, 'old.txt'))

  const root = repo.replaceAll('\\', '/')
  const at = '2026-09-15T10:00:00.000Z'
  const record = (type: string, payload: unknown) => ({ type, timestamp: at, payload })
  const files = (id: string, changes: Record<string, unknown>) =>
    record('event_msg', {
      type: 'item_completed',
      turn_id: 'turn-one',
      item: { type: 'FileChange', id, changes },
      started_at_ms: Date.parse(at),
    })
  const codexHome = temp('codex-undo-home-')
  const sessions = path.join(codexHome, 'sessions', '2026', '09', '15')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    path.join(sessions, 'rollout-native-session.jsonl'),
    [
      record('session_meta', { id: 'native-session', cwd: repo, timestamp: at }),
      record('event_msg', { type: 'task_started', turn_id: 'turn-one' }),
      files('first-edit', {
        [`${root}/f.txt`]: {
          type: 'update',
          unified_diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n',
        },
        [`${root}/g.txt`]: { type: 'update', unified_diff: '@@ -1,3 +1,3 @@\n x\n-y\n+Y\n z\n' },
        [`${root}/new.txt`]: { type: 'add', content: 'fresh\n' },
      }),
      files('second-edit', {
        [`${root}/f.txt`]: {
          type: 'update',
          unified_diff: '@@ -1,3 +1,3 @@\n one\n-TWO\n+2\n three\n',
        },
        [`${root}/old.txt`]: { type: 'delete', content: 'gone\n' },
        [`${root}/__init__.py`]: { type: 'add', content: '' },
      }),
      record('event_msg', { type: 'task_complete', turn_id: 'turn-one' }),
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  )
  const source = createCodexHistorySource({ codexHome })
  const events = await source.read((await source.list())[0]!)
  const updated = events.find((event) => event.type === 'diff.updated')
  const diff = updated?.type === 'diff.updated' ? updated.diff : ''

  expect(diff.match(/^diff --git .*$/gm)).toEqual(
    ['f.txt', 'g.txt', 'new.txt', 'old.txt'].map(
      (name) => `diff --git a/${root}/${name} b/${root}/${name}`,
    ),
  )
  await reverseUnifiedDiff(repo, diff)

  expect(readFileSync(path.join(repo, 'f.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  expect(readFileSync(path.join(repo, 'g.txt'), 'utf8')).toBe('x\ny\nz\n')
  expect(readFileSync(path.join(repo, 'old.txt'), 'utf8')).toBe('gone\n')
  expect(existsSync(path.join(repo, 'new.txt'))).toBe(false)
  expect(existsSync(path.join(repo, 'dev'))).toBe(false)
})
