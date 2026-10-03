import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CustomHarnessStore } from './custom-harnesses.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('custom harnesses', () => {
  it('persists argv without turning it into a shell command', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-custom-cli-'))
    roots.push(root)
    const location = path.join(root, 'custom-harnesses.json')
    const store = new CustomHarnessStore(location)

    store.upsert({
      id: 'codex-fork',
      displayName: 'Codex Fork',
      provider: 'codex',
      command: '/Applications/Codex forks/codex-fork',
      args: ['--profile', 'value with spaces'],
      workingDirectory: '~/Developer/codex-fork',
      environment: { CODEX_HOME: '/Users/me/.codex-fork' },
    })

    expect(store.get('codex-fork')).toMatchObject({
      command: '/Applications/Codex forks/codex-fork',
      args: ['--profile', 'value with spaces'],
      workingDirectory: '~/Developer/codex-fork',
      environment: { CODEX_HOME: '/Users/me/.codex-fork' },
    })
    expect(JSON.parse(readFileSync(location, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('hides and preserves harnesses on providers this build does not ship', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-custom-cli-'))
    roots.push(root)
    const location = path.join(root, 'custom-harnesses.json')
    const nightlyOnly = {
      id: 'deepseek-pi',
      displayName: 'DeepSeek Pi',
      provider: 'pi',
      command: 'deepseek-pi',
      args: [],
    }
    writeFileSync(location, JSON.stringify({ version: 1, harnesses: [nightlyOnly] }))
    const store = new CustomHarnessStore(location)

    expect(store.list()).toEqual([])
    expect(store.find('deepseek-pi')).toBeUndefined()
    store.upsert({ id: 'first', displayName: 'First', provider: 'codex', command: 'c', args: [] })

    expect(store.list().map((harness) => harness.id)).toEqual(['first'])
    expect(JSON.parse(readFileSync(location, 'utf8')).harnesses).toEqual([
      expect.objectContaining({ id: 'first' }),
      nightlyOnly,
    ])
  })

  it('updates and removes one entry without touching its neighbours', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-custom-cli-'))
    roots.push(root)
    const store = new CustomHarnessStore(path.join(root, 'custom-harnesses.json'))
    store.upsert({
      id: 'first',
      displayName: 'First',
      provider: 'codex',
      command: 'codex-first',
      args: [],
    })
    store.upsert({
      id: 'second',
      displayName: 'Second',
      provider: 'claude-code',
      command: 'claude-second',
      args: [],
    })
    store.upsert({
      id: 'first',
      displayName: 'First updated',
      provider: 'codex',
      command: 'codex-first',
      args: ['--profile', 'test'],
    })
    store.remove('second')

    expect(store.list()).toEqual([
      expect.objectContaining({ id: 'first', displayName: 'First updated' }),
    ])
  })
})
