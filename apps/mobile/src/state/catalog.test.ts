import { describe, expect, it, vi } from 'vitest'
import type { Connection } from '../link/connection'

vi.mock('../../modules/tastecode-link', () => ({ TasteLink: {} }))

const { Catalog, sourceKey } = await import('./catalog')

const capabilities = { multipleAccounts: true }
const providers = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    installed: true,
    auth: 'authenticated',
    capabilities,
  },
  { id: 'codex', displayName: 'Codex', installed: true, auth: 'authenticated', capabilities },
  { id: 'grok', displayName: 'Grok', installed: true, auth: 'authenticated' },
  { id: 'acp', displayName: 'ACP', installed: true, auth: 'authenticated' },
]
const accounts = {
  accounts: [
    { id: 'default', provider: 'claude-code', label: 'Personal', managed: false },
    { id: 'team', provider: 'claude-code', label: 'Team', managed: true, email: 'me@team.dev' },
    { id: 'old', provider: 'claude-code', label: 'Signed out', managed: true },
    { id: 'default', provider: 'codex', label: 'Default', managed: false },
  ],
  active: { 'claude-code': 'team' },
}

function fakeComputer(roster: string[] | null) {
  const channels = new Map<string, (data: unknown) => void>()
  let saved = roster
  const replies = {
    'providers.list': { providers },
    'accounts.list': accounts,
    'acp.agents': {
      agents: [
        { id: 'kimi', name: 'Kimi', installed: true },
        { id: 'devin', name: 'Devin', installed: true },
      ],
    },
    'models.list': { models: [] },
  }
  const connection = {
    request: vi.fn(async (method: string) => {
      if (method === 'providers.roster') return { keys: saved }
      if (!(method in replies)) throw new Error(`unknown method ${method}`)
      return replies[method as keyof typeof replies]
    }),
    on: (channel: string, listener: (data: unknown) => void) => {
      channels.set(channel, listener)
      return () => channels.delete(channel)
    },
    onOpen: () => () => undefined,
  }
  return {
    catalog: new Catalog(connection as unknown as Connection),
    /** The desktop saved a new roster: the computer answers with it and pushes it. */
    saveRoster: (keys: string[]) => {
      saved = keys
      channels.get('providers.roster')?.({ keys })
    },
  }
}

const names = (catalog: InstanceType<typeof Catalog>) =>
  catalog.state.get().sources.map((source) => source.name)

describe('the sources the phone offers', () => {
  it('leaves out the providers and agents the desktop removed', async () => {
    const { catalog } = fakeComputer(['codex', 'acp:kimi'])
    await catalog.load()
    expect(names(catalog)).toEqual(['Codex', 'Kimi'])
  })

  it('offers every source while the desktop has not said', async () => {
    const { catalog } = fakeComputer(null)
    await catalog.load()
    expect(names(catalog)).toContain('Grok')
    expect(names(catalog)).toContain('Devin')
  })

  it('follows the desktop when it adds or removes one', async () => {
    const { catalog, saveRoster } = fakeComputer(['codex'])
    await catalog.load()
    saveRoster(['grok'])
    await vi.waitFor(() => expect(names(catalog)).toEqual(['Grok']))
  })

  it('lists each signed-in account, the one new chats start on first', async () => {
    const { catalog } = fakeComputer(['claude-code', 'codex'])
    await catalog.load()
    const sources = catalog.state.get().sources
    expect(sources.map((source) => [source.name, source.accountId])).toEqual([
      ['Claude Code (Team)', 'team'],
      ['Claude Code (Personal)', 'default'],
      ['Codex', undefined],
    ])
    // A chat on the default account names none, and finds its source.
    expect(sources[1]?.key).toBe(sourceKey({ provider: 'claude-code' }))
  })
})
