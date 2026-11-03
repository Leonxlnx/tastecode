import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item, ProviderHistorySession, ProviderHistorySource } from '@harness/contracts'
import { ProviderHistory } from './provider-history.js'
import { Store } from './store.js'

const call: Item = {
  id: 'native-call',
  turnId: 'turn',
  type: 'tool_call',
  status: 'completed',
  createdAt: 1000,
  subagent: { id: 'native-tool', state: 'completed' },
}
const items: Item[] = [
  {
    id: 'prompt',
    turnId: 'child',
    type: 'message',
    role: 'user',
    text: 'Read the file',
    status: 'completed',
    createdAt: 1000,
  },
  {
    id: 'tool',
    turnId: 'child',
    type: 'tool_call',
    text: 'Read',
    status: 'completed',
    createdAt: 1001,
  },
  {
    id: 'answer',
    turnId: 'child',
    type: 'message',
    role: 'assistant',
    text: 'The answer',
    status: 'completed',
    createdAt: 1002,
  },
]
let store: Store
let history: ProviderHistory
let source: ProviderHistorySource
beforeEach(() => {
  store = new Store(':memory:')
  store.addProject(process.cwd())
  store.addThread({
    id: 'parent',
    provider: 'codex',
    providerSessionId: 'native-session',
    projectPath: process.cwd(),
    title: 'Parent',
  })
  store.append('parent', { type: 'item.completed', item: call })
  source = {
    list: vi.fn(async () => []),
    read: vi.fn(async () => []),
    readSubagentTranscript: vi.fn(async () => items),
  }
  history = new ProviderHistory(store, [{ provider: 'codex', history: source }], {
    isBusy: () => true,
    changed: vi.fn(),
    log: vi.fn(),
  })
})
afterEach(async () => {
  await history.close()
  store.close()
})

describe('native subagent transcripts', () => {
  it('reads the adapter capability for a running parent before any scan without importing history', async () => {
    await expect(history.readSubagentTranscript('parent', call.id)).resolves.toEqual(items)
    expect(source.readSubagentTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'native-session', workspacePath: process.cwd() }),
      call,
    )
    expect(source.list).not.toHaveBeenCalled()
    expect(source.read).not.toHaveBeenCalled()
    expect(store.history('parent')).toHaveLength(1)
  })

  it('passes linked saved-session metadata and the newest stored snapshot', async () => {
    const session: ProviderHistorySession = {
      id: 'native-session',
      workspacePath: process.cwd(),
      title: 'Parent',
      createdAt: 1000,
      updatedAt: 2000,
      revision: 'saved',
      locator: 'opaque-location',
    }
    store.saveProviderHistory('codex', 'parent', session)
    await history.close()
    history = new ProviderHistory(store, [{ provider: 'codex', history: source }], {
      isBusy: () => false,
      changed: vi.fn(),
      log: vi.fn(),
    })
    const latest: Item = { ...call, subagent: { ...call.subagent!, summary: 'Latest report' } }
    store.append('parent', { type: 'item.completed', item: latest })
    await history.readSubagentTranscript('parent', call.id)
    expect(source.readSubagentTranscript).toHaveBeenCalledWith(session, latest)
  })

  it('returns no items for an adapter without the optional capability', async () => {
    delete source.readSubagentTranscript
    await expect(history.readSubagentTranscript('parent', call.id)).resolves.toEqual([])
  })

  it('rejects subagents removed from imported history', async () => {
    const imported = { ...call, id: 'imported-call' }
    store.mergeProviderHistory('parent', '1', [
      { key: imported.id, event: { type: 'item.completed', item: imported } },
    ])
    await expect(history.readSubagentTranscript('parent', imported.id)).resolves.toEqual(items)
    store.mergeProviderHistory('parent', '2', [])
    await expect(history.readSubagentTranscript('parent', imported.id)).rejects.toThrow(
      'Native subagent not found',
    )
  })

  it('reads a second account only through its scoped source and never falls back after removal', async () => {
    store.addThread({
      id: 'second',
      provider: 'codex',
      providerSessionId: 'account-session',
      accountId: 'second-account',
      projectPath: process.cwd(),
      title: 'Second account',
    })
    store.append('second', { type: 'item.completed', item: call })
    const scoped: ProviderHistorySource = {
      list: vi.fn(async () => []),
      read: vi.fn(async () => []),
      readSubagentTranscript: vi.fn(async () => items),
      dispose: vi.fn(),
    }
    const forAccount = vi.fn(async () => scoped)
    const accountHome = vi.fn(() => 'account-home')
    await history.close()
    history = new ProviderHistory(store, [{ provider: 'codex', history: source, forAccount }], {
      isBusy: () => false,
      changed: vi.fn(),
      log: vi.fn(),
      accountHome,
    })
    for (let read = 0; read < 2; read++)
      await expect(history.readSubagentTranscript('second', call.id)).resolves.toEqual(items)
    expect(forAccount).toHaveBeenCalledExactlyOnceWith('account-home')
    expect(scoped.readSubagentTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'account-session' }),
      call,
    )
    expect(source.readSubagentTranscript).not.toHaveBeenCalled()
    expect(scoped.list).not.toHaveBeenCalled()
    accountHome.mockImplementation(() => {
      throw new Error('Account removed')
    })
    await expect(history.readSubagentTranscript('second', call.id)).rejects.toThrow(
      'Account removed',
    )
    expect(source.readSubagentTranscript).not.toHaveBeenCalled()
    await history.close()
    expect(scoped.dispose).toHaveBeenCalledOnce()
  })

  it('does not read the default account when a named account cannot be resolved', async () => {
    store.addThread({
      id: 'second',
      provider: 'codex',
      providerSessionId: 'account-session',
      accountId: 'second-account',
      projectPath: process.cwd(),
      title: 'Second account',
    })
    store.append('second', { type: 'item.completed', item: call })
    await expect(history.readSubagentTranscript('second', call.id)).resolves.toEqual([])
    expect(source.readSubagentTranscript).not.toHaveBeenCalled()
  })

  it('does not substitute a local chat id for a missing provider session', async () => {
    store.addThread({
      id: 'no-session',
      provider: 'codex',
      projectPath: process.cwd(),
      title: 'New',
    })
    store.append('no-session', { type: 'item.completed', item: call })
    await expect(history.readSubagentTranscript('no-session', call.id)).resolves.toEqual([])
    expect(source.readSubagentTranscript).not.toHaveBeenCalled()
  })

  it("rejects another chat's item, missing chats, and a TasteCode-owned child", async () => {
    store.addThread({ id: 'other', provider: 'codex', projectPath: process.cwd(), title: 'Other' })
    await expect(history.readSubagentTranscript('missing', call.id)).rejects.toThrow(
      'Thread not found',
    )
    await expect(history.readSubagentTranscript('other', call.id)).rejects.toThrow(
      'Native subagent not found',
    )
    await expect(history.readSubagentTranscript('parent', 'missing')).rejects.toThrow(
      'Native subagent not found',
    )
    store.append('parent', {
      type: 'item.completed',
      item: { ...call, subagent: { ...call.subagent!, threadId: 'owned-child' } },
    })
    await expect(history.readSubagentTranscript('parent', call.id)).rejects.toThrow(
      'Native subagent not found',
    )
    expect(source.readSubagentTranscript).not.toHaveBeenCalled()
  })

  it('keeps unavailable files empty and reports read failures for a retry', async () => {
    vi.mocked(source.readSubagentTranscript!)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Read failed'))
    await expect(history.readSubagentTranscript('parent', call.id)).resolves.toEqual([])
    await expect(history.readSubagentTranscript('parent', call.id)).rejects.toThrow('Read failed')
  })
})
