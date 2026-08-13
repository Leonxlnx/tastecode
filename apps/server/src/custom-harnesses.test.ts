import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
      id: 'deepseek-pi',
      displayName: 'DeepSeek Pi',
      provider: 'pi',
      command: '/Applications/Pi forks/deepseek-pi',
      args: ['--openrouter', 'value with spaces'],
      workingDirectory: '~/Developer/pi-deepseek',
      environment: { PI_CODING_AGENT_DIR: '/Users/me/.pi-deepseek' },
    })

    expect(store.get('deepseek-pi')).toMatchObject({
      command: '/Applications/Pi forks/deepseek-pi',
      args: ['--openrouter', 'value with spaces'],
      workingDirectory: '~/Developer/pi-deepseek',
      environment: { PI_CODING_AGENT_DIR: '/Users/me/.pi-deepseek' },
    })
    expect(JSON.parse(readFileSync(location, 'utf8'))).toMatchObject({ version: 1 })
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
