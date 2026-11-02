import { readFileSync } from 'node:fs'
import type { JsonRpcValue } from '@harness/proc'
import { JsonRpcError } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { AcpAdapter } from './adapter.js'
import { NewSessionResultSchema } from './protocol.js'
import { modelConfigOption, sessionModels } from './session-models.js'

/**
 * Captured session/new results (2026-10-19), trimmed to a few model options:
 * Devin and Kilo name their models only in a `model` config option; Mistral
 * Vibe sends the draft `models` list beside it.
 */
function fixture(name: string) {
  return NewSessionResultSchema.parse(
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
  )
}

type Answer = (params: unknown) => JsonRpcValue | Promise<JsonRpcValue>
/** How the fake agent answers the two requests a probe or a new chat makes. */
type AgentAnswers = { initialize: Answer; 'session/new': Answer }
let answers: AgentAnswers | undefined
const sent: Array<{ method: string; params: unknown }> = []

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    onStderr(): void {}
    onNotification(): void {}
    onServerRequest(): void {}
    notify(): void {}
    dispose(): void {}
    async request(
      method: string,
      params: unknown,
      options: { result?: { parse(v: unknown): unknown } } = {},
    ) {
      sent.push({ method, params })
      const answer = answers?.[method as keyof AgentAnswers]
      const value = answer ? await answer(params) : null
      return options.result ? options.result.parse(value) : value
    }
  },
}))

const initialize: Answer = () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } })

describe('ACP session models', () => {
  it('reads the model select an agent names on a new session', () => {
    const devin = fixture('session-new-devin-3000.11.3.json')
    expect(modelConfigOption(devin)?.id).toBe('model')
    const models = sessionModels(devin)
    expect(models.map((model) => model.id)).toEqual([
      'adaptive',
      'swe-2-high',
      'swe-1-7-lightning-medium',
      'claude-fable-5-1-medium',
      'gemini-4-argon-medium',
    ])
    // The session's current value is the agent's own default.
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual([
      'gemini-4-argon-medium',
    ])
    expect(models[1]).toEqual({
      id: 'swe-2-high',
      displayName: 'SWE-2',
      isDefault: false,
      reasoningEfforts: [],
      serviceTiers: [],
    })
  })

  it('keeps the select apart from other config options such as effort', () => {
    const kilo = fixture('session-new-kilo-7.8.12.json')
    expect(sessionModels(kilo).map((model) => model.id)).toEqual([
      'kilo/aion-labs/aion-3.5',
      'kilo/aion-labs/aion-3.5-mini',
      'kilo/aion-labs/aion-2.0',
      'kilo/google/gemini-3-pro-image',
    ])
  })

  it('prefers the config option over the draft models list, and falls back to it', () => {
    const vibe = fixture('session-new-vibe-acp-2.7.2.json')
    expect(sessionModels(vibe).map((model) => [model.id, model.isDefault])).toEqual([
      ['devstral-2', true],
      ['devstral-small', false],
      ['local', false],
    ])
    expect(
      sessionModels({ ...vibe, configOptions: [] }).map((model) => [model.id, model.isDefault]),
    ).toEqual([
      ['devstral-2', true],
      ['devstral-small', false],
      ['local', false],
    ])
  })

  it('flattens grouped options and drops repeats', () => {
    expect(
      sessionModels({
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: 'b',
            options: [
              { group: 'fast', name: 'Fast', options: [{ value: 'a', name: 'A' }] },
              { group: 'smart', name: 'Smart', options: [{ value: 'b' }, { value: 'a' }] },
            ],
          },
        ],
      }).map((model) => [model.id, model.displayName, model.isDefault]),
    ).toEqual([
      ['a', 'A', false],
      ['b', 'b', true],
    ])
  })
})

describe('ACP session probe', () => {
  it('reports signed in with the models of the session the agent opened', async () => {
    const vibe = fixture('session-new-vibe-acp-2.7.2.json')
    answers = { initialize, 'session/new': () => vibe as JsonRpcValue }
    const probe = await new AcpAdapter('vibe').probeSession()
    expect(probe.signedIn).toBe(true)
    expect(probe.models.map((model) => model.id)).toEqual(['devstral-2', 'devstral-small', 'local'])
  })

  it('reports signed out when the agent refuses the session with auth_required', async () => {
    answers = {
      initialize,
      // Droid 0.233.0, Copilot 1.0.100, Qoder 1.1.74 and CodeBuddy all answer so.
      'session/new': () => {
        throw new JsonRpcError(-32000, 'Authentication required')
      },
    }
    expect(await new AcpAdapter('droid').probeSession()).toEqual({ signedIn: false, models: [] })
  })

  it('passes any other failure on', async () => {
    answers = {
      initialize,
      'session/new': () => {
        throw new JsonRpcError(-32603, 'internal error')
      },
    }
    await expect(new AcpAdapter('droid').probeSession()).rejects.toThrow('internal error')
  })

  it('applies a chat model through the select the session named', async () => {
    const devin = fixture('session-new-devin-3000.11.3.json')
    answers = { initialize, 'session/new': () => devin as JsonRpcValue }
    sent.length = 0
    const adapter = new AcpAdapter('devin')
    await adapter.startThread('/tmp/project', { model: 'swe-2-high' })
    expect(sent.filter((entry) => entry.method === 'session/set_config_option')).toEqual([
      {
        method: 'session/set_config_option',
        params: { sessionId: devin.sessionId, configId: 'model', value: 'swe-2-high' },
      },
    ])
    await adapter.dispose()
  })
})

describe('ACP probe reuse', () => {
  it('asks again after a signed-out answer, so a finished sign-in shows at once', async () => {
    const { probeAgentSession } = await import('./adapter.js')
    let signedIn = false
    let sessions = 0
    answers = {
      initialize,
      'session/new': () => {
        sessions += 1
        if (!signedIn) throw new JsonRpcError(-32000, 'Authentication required')
        return { sessionId: `probe-${sessions}` }
      },
    }
    expect((await probeAgentSession('copilot')).signedIn).toBe(false)
    signedIn = true
    expect((await probeAgentSession('copilot')).signedIn).toBe(true)
    // A signed-in answer serves the model list asked for right after it.
    expect((await probeAgentSession('copilot')).signedIn).toBe(true)
    expect(sessions).toBe(2)
  })

  it('shares one probe between checks asked for at the same time', async () => {
    const { probeAgentSession } = await import('./adapter.js')
    let sessions = 0
    answers = {
      initialize,
      'session/new': () => ({ sessionId: `probe-${++sessions}` }),
    }
    const [first, second] = await Promise.all([
      probeAgentSession('cline'),
      probeAgentSession('cline'),
    ])
    expect(first).toBe(second)
    expect(sessions).toBe(1)
  })
})
