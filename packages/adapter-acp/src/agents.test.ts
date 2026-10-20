import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acpAccount, acpSignOut } from './account.js'
import { AcpAdapter, parseAcpThreadId } from './adapter.js'
import {
  ACP_AGENTS,
  LISTED_AGENTS,
  acpCanSignOut,
  discoverAgentModels,
  findAgentSpec,
  parseKimiModels,
} from './agents.js'

describe('ACP persisted sessions', () => {
  it('keeps provider-native session ids intact', () => {
    expect(parseAcpThreadId('acp-kimi-session_abc-123', 'kimi')).toBe('session_abc-123')
    expect(() => parseAcpThreadId('acp-gemini-session_abc', 'kimi')).toThrow('does not belong')
  })

  it('records the Kimi wire version verified by the real binary', () => {
    expect(findAgentSpec('kimi')).toMatchObject({
      command: 'kimi',
      args: ['acp'],
      verified: true,
      supportedVersion: '0.29',
    })
  })

  it('hides retired agents from listings but keeps them resumable', () => {
    // Gemini CLI is superseded by Antigravity; old threads must still resume.
    expect(LISTED_AGENTS.some((agent) => agent.id === 'gemini')).toBe(false)
    expect(LISTED_AGENTS.some((agent) => agent.id === 'qwen')).toBe(false)
    expect(findAgentSpec('gemini')).toMatchObject({ command: 'gemini', retired: true })
  })

  it('reports Kimi signed in only once the login left its credential file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-home-'))
    try {
      expect(await acpAccount('kimi', home)).toEqual({ signedIn: false })
      mkdirSync(join(home, '.kimi-code', 'credentials'), { recursive: true })
      writeFileSync(join(home, '.kimi-code', 'credentials', 'kimi-code.json'), '{}')
      expect(await acpAccount('kimi', home)).toEqual({ signedIn: true })
      // No check declared for Qwen: state is unknown, reported signed-out so
      // the sign-in flow stays reachable.
      expect(await acpAccount('qwen', home)).toEqual({ signedIn: false })
      // Sign-out deletes exactly the file the login left, and nothing else.
      await acpSignOut('kimi', home)
      expect(await acpAccount('kimi', home)).toEqual({ signedIn: false })
      await expect(acpSignOut('qwen', home)).rejects.toThrow('does not support')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('offers sign-out only where a command or credential file can do it', () => {
    expect(acpCanSignOut(findAgentSpec('kimi')!)).toBe(true)
    expect(acpCanSignOut(findAgentSpec('devin')!)).toBe(true)
    expect(acpCanSignOut(findAgentSpec('droid')!)).toBe(false)
  })
})

describe('ACP agent library', () => {
  it('lists each library agent once, with its maker and a way to set it up', () => {
    const ids = LISTED_AGENTS.map((agent) => agent.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const agent of LISTED_AGENTS) {
      expect(agent.maker, agent.id).toBeTruthy()
      expect(agent.setup.installUrl, agent.id).toMatch(/^https:\/\//)
      expect(agent.setup.login, agent.id).toBe('provider')
    }
  })

  it('keeps every thread id prefix unambiguous', () => {
    // `acp-<id>-<session>` names a chat's agent, and `acp-grok-` is Grok's own.
    const ids = [...ACP_AGENTS.map((agent) => agent.id), 'grok']
    for (const id of ids) {
      for (const other of ids) {
        if (id !== other) expect(other.startsWith(`${id}-`), `${id} / ${other}`).toBe(false)
      }
    }
    expect(ids.filter((id) => id === 'grok')).toHaveLength(1)
  })

  it('does not repeat an agent that is already a provider of its own', () => {
    const providers = ['claude', 'codex', 'grok', 'cursor', 'opencode', 'antigravity', 'agy', 'pi']
    for (const agent of LISTED_AGENTS) {
      expect(providers, agent.id).not.toContain(agent.id)
      expect(providers, agent.id).not.toContain(agent.command)
    }
  })

  it('checks a sign-in for every listed agent, so none shows a sign-in it cannot know', () => {
    for (const agent of LISTED_AGENTS) {
      expect(
        Boolean(agent.authStatus ?? agent.credentialProbe ?? agent.sessionModels),
        agent.id,
      ).toBe(true)
    }
  })

  it('installs from the vendor script on each platform it publishes one for', () => {
    const devin = findAgentSpec('devin')!
    expect(devin.setup.installCommand).toContain('bash')
    expect(findAgentSpec('copilot')!.setup.installCommand).toBe('npm install -g @github/copilot')
  })
})

describe('ACP model discovery', () => {
  it('offers the concrete Gemini model names the CLI accepts', async () => {
    expect(await discoverAgentModels('gemini')).toMatchObject([
      { id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro (Preview)', isDefault: true },
      { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (Preview)' },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
    ])
  })

  it('normalizes the models reported by Kimi itself', () => {
    expect(
      parseKimiModels(
        JSON.stringify({
          models: {
            'kimi-code/k3': {
              displayName: 'Kimi K3',
              supportEfforts: ['low', 'high'],
              defaultEffort: 'high',
            },
          },
        }),
      ),
    ).toEqual([
      {
        id: 'kimi-code/k3',
        displayName: 'Kimi K3',
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
        lab: 'Moonshot',
        family: 'kimi-k',
        generation: '3',
      },
    ])
  })

  it('declares one Kimi K line, so the newest K supersedes older variants', () => {
    // The catalog the Kimi CLI listed on 2026-10-18, in its own order.
    const models = parseKimiModels(
      JSON.stringify({
        models: {
          'kimi-code/kimi-for-coding': { displayName: 'K2.8 Preview' },
          'kimi-code/kimi-for-coding-highspeed': { displayName: 'K2.7 Code Highspeed' },
          'kimi-code/k3': { displayName: 'K3' },
          'kimi-code/k3-256k': { displayName: 'K3-256k' },
          'kimi-code/custom': {},
        },
      }),
    )
    expect(models.map(({ id, family, generation }) => ({ id, family, generation }))).toEqual([
      { id: 'kimi-code/kimi-for-coding', family: 'kimi-k', generation: '2.8' },
      { id: 'kimi-code/kimi-for-coding-highspeed', family: 'kimi-k', generation: '2.7' },
      { id: 'kimi-code/k3', family: 'kimi-k', generation: '3' },
      { id: 'kimi-code/k3-256k', family: 'kimi-k', generation: '3' },
      // A name without a K version declares no lineage.
      { id: 'kimi-code/custom', family: undefined, generation: undefined },
    ])
  })
})

describe('ACP registered launches', () => {
  it('constructs registered agents and rejects unknown ids', async () => {
    const adapter = new AcpAdapter('gemini')
    expect(await adapter.listModels()).toEqual(await discoverAgentModels('gemini'))
    expect(() => new AcpAdapter('not-a-registered-agent')).toThrow('unknown ACP agent')
    await adapter.dispose()
  })
})
