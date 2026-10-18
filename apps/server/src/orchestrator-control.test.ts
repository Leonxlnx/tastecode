import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account, Model } from '@harness/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from './store.js'

const control = vi.hoisted(() => ({
  constructed: 0,
  started: 0,
  disposed: 0,
  listed: 0,
  models: [] as Model[],
  account: { signedIn: true, email: 'one@example.test' } as Account,
  releases: [] as Array<() => void>,
  usageChanged: undefined as (() => void) | undefined,
  login: undefined as
    | ((result: { loginId: string | null; success: boolean; error: string | null }) => void)
    | undefined,
}))

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      constructor() {
        control.constructed += 1
      }

      on(
        event: string,
        listener: (result: {
          loginId: string | null
          success: boolean
          error: string | null
        }) => void,
      ): void {
        if (event === 'login') control.login = listener
      }
      onUsageChanged(listener: () => void): void {
        control.usageChanged = listener
      }
      dispose(): void {
        control.disposed += 1
      }
      listModels() {
        control.listed += 1
        return [...control.models]
      }
      account() {
        return control.account
      }
      async listSkills() {
        return {
          skills: [
            {
              id: 'codex:plugin:review',
              name: 'review',
              description: 'Review the change',
              source: { type: 'provider' as const },
              scope: 'system' as const,
              enabled: true,
              dependencyErrors: [],
            },
          ],
          errors: [],
        }
      }
      startLogin() {
        return { loginId: 'login-1', authUrl: 'https://example.test/login' }
      }

      start(): Promise<void> {
        control.started += 1
        return new Promise((resolve) => control.releases.push(resolve))
      }
    },
  }
})

import { Orchestrator, providerTerminalSource } from './orchestrator.js'

beforeEach(() => {
  control.constructed = 0
  control.started = 0
  control.disposed = 0
  control.listed = 0
  control.models = []
  control.account = { signedIn: true, email: 'one@example.test' }
  control.releases = []
  control.usageChanged = undefined
  control.login = undefined
})

describe('control adapter startup', () => {
  it('forwards the long-lived control adapter usage signal', async () => {
    const changed = vi.fn()
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onUsageChanged: changed,
    })

    const started = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await started
    control.usageChanged?.()

    expect(changed).toHaveBeenCalledWith('codex')
    await orchestrator.disposeAll()
  })

  it('ignores a control signal after disposal', async () => {
    const changed = vi.fn()
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onUsageChanged: changed,
    })
    const started = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await started

    await orchestrator.disposeAll()
    control.usageChanged?.()

    expect(changed).not.toHaveBeenCalled()
  })

  it('shares one startup across concurrent settings requests', async () => {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
    })

    const first = orchestrator.listModels('codex')
    const second = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.started).toBe(1))

    expect(control.constructed).toBe(1)
    control.releases[0]?.()
    await expect(Promise.all([first, second])).resolves.toEqual([[], []])
    await orchestrator.disposeAll()
  })

  it('releases an idle control adapter and starts a fresh one for a later request', async () => {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      controlIdleMs: 0,
    })

    const first = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await first
    await vi.waitFor(() => expect(control.disposed).toBe(1))

    // The model list itself is shared now, so a second control read starts the process.
    const second = orchestrator.account('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(2))
    control.releases[1]?.()
    await second
    await vi.waitFor(() => expect(control.disposed).toBe(2))

    expect(control.constructed).toBe(2)
    await orchestrator.disposeAll()
  })

  it('keeps the control adapter alive until an interactive login completes', async () => {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      controlIdleMs: 0,
    })

    const login = orchestrator.startLogin('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await expect(login).resolves.toEqual({
      loginId: 'login-1',
      authUrl: 'https://example.test/login',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(control.disposed).toBe(0)

    control.login?.({ loginId: 'login-1', success: true, error: null })
    await vi.waitFor(() => expect(control.disposed).toBe(1))
    await orchestrator.disposeAll()
  })

  it('adds .agents skills to the Codex inventory, since Codex loads them', async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'harness-codex-skills-project-'))
    const home = mkdtempSync(path.join(os.tmpdir(), 'harness-codex-skills-home-'))
    const skillDir = path.join(home, '.agents', 'skills', 'animate')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: animate\ndescription: Animate\n---\n',
    )
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home)
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
    })
    try {
      const listing = orchestrator.listSkills('codex', project)
      await vi.waitFor(() => expect(control.releases).toHaveLength(1))
      control.releases[0]?.()
      const inventory = await listing
      expect(inventory.skills.map((skill) => [skill.name, skill.scope])).toEqual([
        ['review', 'system'],
        ['animate', 'user'],
      ])
    } finally {
      homedir.mockRestore()
      await orchestrator.disposeAll()
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('shared model lists', () => {
  const row = (id: string): Model => ({
    id,
    displayName: id,
    isDefault: false,
    reasoningEfforts: [],
    serviceTiers: [],
  })

  async function started(onModelsChanged = vi.fn()) {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onModelsChanged,
    })
    const first = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    return { orchestrator, first, onModelsChanged }
  }

  it('answers repeated requests from one listing', async () => {
    control.models = [row('gpt-6.1-sol')]
    const { orchestrator, first } = await started()
    await expect(first).resolves.toEqual([row('gpt-6.1-sol')])
    await expect(orchestrator.listModels('codex')).resolves.toEqual([row('gpt-6.1-sol')])
    expect(control.listed).toBe(1)
    await orchestrator.disposeAll()
  })

  it('lists again after a sign-in and announces a changed lineup', async () => {
    control.models = [row('gpt-6-astra')]
    const { orchestrator, first, onModelsChanged } = await started()
    await first

    control.models = [row('gpt-6-astra'), row('gpt-6.1-sol')]
    control.login?.({ loginId: null, success: true, error: null })
    // The known list answers at once while the new account's list is read.
    await expect(orchestrator.listModels('codex')).resolves.toEqual([row('gpt-6-astra')])
    await vi.waitFor(() => expect(onModelsChanged).toHaveBeenCalledWith('codex', undefined))
    expect(control.listed).toBe(2)
    await expect(orchestrator.listModels('codex')).resolves.toEqual([
      row('gpt-6-astra'),
      row('gpt-6.1-sol'),
    ])
    await orchestrator.disposeAll()
  })

  it('notices an account switch made in the CLI', async () => {
    control.models = [row('gpt-6-astra')]
    const { orchestrator, first, onModelsChanged } = await started()
    await first
    await orchestrator.account('codex')
    await orchestrator.listModels('codex')
    expect(control.listed).toBe(1)

    control.account = { signedIn: true, email: 'two@example.test' }
    control.models = [row('gpt-6-luna')]
    // A signed-in account read answers for a minute; the first read after that sees the switch.
    const realNow = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000)
    try {
      await orchestrator.account('codex')
      await orchestrator.listModels('codex')
      await vi.waitFor(() => expect(onModelsChanged).toHaveBeenCalledOnce())
    } finally {
      clock.mockRestore()
    }
    expect(control.listed).toBe(2)
    await orchestrator.disposeAll()
  })

  it('keeps the model list through an account read that names no email or plan', async () => {
    control.models = [row('gpt-6-astra')]
    const { orchestrator, first } = await started()
    await first
    await orchestrator.account('codex')

    // The CLI could confirm only that someone is signed in.
    control.account = { signedIn: true }
    const realNow = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000)
    try {
      await orchestrator.account('codex')
      await expect(orchestrator.listModels('codex')).resolves.toEqual([row('gpt-6-astra')])
      // A list read in the background would have started by now.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      clock.mockRestore()
    }
    expect(control.listed).toBe(1)
    await orchestrator.disposeAll()
  })

  it('reads the source of an install, update or sign-in terminal', () => {
    expect(providerTerminalSource('claude-code')).toEqual({ provider: 'claude-code' })
    expect(providerTerminalSource('acp:kimi')).toEqual({ provider: 'acp', agent: 'kimi' })
    expect(providerTerminalSource('update:codex')).toEqual({ provider: 'codex' })
    expect(providerTerminalSource('update:nope')).toBeUndefined()
    expect(providerTerminalSource('nope')).toBeUndefined()
  })
})
