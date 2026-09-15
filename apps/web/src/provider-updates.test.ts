// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUpdate } from '@harness/contracts'
import { TestTransport } from './test-transport.js'
import { ProviderUpdatesStore } from './provider-updates.js'
import { installState, resetInstalls, updateKey } from './provider-install.js'

const available: ProviderUpdate = {
  provider: 'codex',
  displayName: 'Codex',
  currentVersion: '0.9.0',
  latestVersion: '0.11.0',
  updateAvailable: true,
  canUpdate: true,
  updateUrl: 'https://developers.openai.com/codex/cli',
}

afterEach(() => {
  resetInstalls()
  vi.useRealTimers()
})

describe('provider updates lifecycle', () => {
  it('clears an old failure when a manual recheck finds the CLI was updated elsewhere', async () => {
    let updated = false
    const transport = new TestTransport((method) =>
      method === 'providers.update'
        ? { terminalId: 'update' }
        : {
            updates: [
              {
                ...available,
                currentVersion: updated ? available.latestVersion : available.currentVersion,
                updateAvailable: !updated,
              },
            ],
          },
    )
    const store = new ProviderUpdatesStore(transport)
    await store.refresh()
    await store.start('codex')
    transport.emit('terminal.exit', { terminalId: 'update', exitCode: 1 })
    expect(store.snapshot().operations.codex?.phase).toBe('failed')
    updated = true
    await store.refresh(true)
    expect(store.snapshot().operations.codex).toBeUndefined()
  })
  it('does not remain stuck updating when the connection loses the terminal exit', async () => {
    let exited = false
    const transport = new TestTransport((method) => {
      if (method === 'providers.update') return { terminalId: 'update' }
      if (method === 'terminal.status')
        return {
          status: exited ? 'exited' : 'running',
          output: 'final error',
          outputOffset: 0,
          exitCode: exited ? 1 : null,
        }
      return { updates: [available] }
    })
    const store = new ProviderUpdatesStore(transport)
    await store.start('codex')
    transport.emitState('reconnecting')
    expect(store.snapshot().operations.codex?.phase).toBe('running')
    exited = true
    transport.emitState('open')
    await vi.waitFor(() => expect(store.snapshot().operations.codex?.phase).toBe('failed'))
    expect(installState(updateKey('codex'))?.log).toBe('final error')
    expect(
      transport.requests.filter((request) => request.method === 'providers.update'),
    ).toHaveLength(1)
  })
  it('deduplicates checks and skips disconnected requests', async () => {
    const transport = new TestTransport(() => ({ updates: [available] }))
    const store = new ProviderUpdatesStore(transport)
    transport.state = 'closed'
    await store.refresh()
    expect(transport.requests).toHaveLength(0)
    transport.state = 'open'
    await Promise.all([store.refresh(), store.refresh()])
    await store.refresh()
    expect(transport.requests).toHaveLength(1)
    await store.refresh(true)
    expect(transport.requests).toHaveLength(2)
  })

  it('starts only one update and verifies the installed version after a fast exit', async () => {
    let updated = false
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates')
        return {
          updates: [
            {
              ...available,
              currentVersion: updated ? '0.11.0' : '0.9.0',
              updateAvailable: !updated,
            },
          ],
        }
      if (method === 'providers.update') {
        updated = true
        transport.emit('terminal.output', { terminalId: 'fast-update', data: 'Updated\r\n' })
        transport.emit('terminal.exit', { terminalId: 'fast-update', exitCode: 0 })
        return { terminalId: 'fast-update' }
      }
      throw new Error(method)
    })
    const store = new ProviderUpdatesStore(transport)
    await store.refresh()
    await Promise.all([store.start('codex'), store.start('codex')])
    await vi.waitFor(() => expect(store.snapshot().operations.codex?.phase).toBe('succeeded'))
    expect(transport.requests.filter((entry) => entry.method === 'providers.update')).toHaveLength(
      1,
    )
    expect(installState(updateKey('codex'))?.log).toBe('Updated\r\n')
    expect(store.snapshot().updates[0]?.currentVersion).toBe('0.11.0')
  })

  it('keeps an unchanged version as a failure even when the installer exits zero', async () => {
    const transport = new TestTransport((method) =>
      method === 'providers.update' ? { terminalId: 'update' } : { updates: [available] },
    )
    const store = new ProviderUpdatesStore(transport)
    await store.refresh()
    await store.start('codex')
    transport.emit('terminal.exit', { terminalId: 'update', exitCode: 0 })
    await vi.waitFor(() =>
      expect(store.snapshot().operations.codex).toMatchObject({
        phase: 'failed',
        error: expect.stringContaining('could not be confirmed'),
      }),
    )
  })

  it('keeps installer failures available for retry', async () => {
    const transport = new TestTransport((method) =>
      method === 'providers.update' ? { terminalId: 'update' } : { updates: [available] },
    )
    const store = new ProviderUpdatesStore(transport)
    await store.start('codex')
    transport.emit('terminal.exit', { terminalId: 'update', exitCode: 1 })
    expect(store.snapshot().operations.codex?.phase).toBe('failed')
    await store.start('codex')
    expect(store.snapshot().operations.codex?.phase).toBe('running')
    transport.emit('terminal.exit', { terminalId: 'update', exitCode: 1 })
  })

  it('handles a failed request without losing the last known releases', async () => {
    let fail = false
    const transport = new TestTransport(() => {
      if (fail) throw new Error('offline')
      return { updates: [available] }
    })
    const store = new ProviderUpdatesStore(transport)
    await store.refresh()
    fail = true
    await store.refresh(true)
    expect(store.snapshot()).toMatchObject({
      checking: false,
      updates: [available],
      error: expect.any(String),
    })
    await store.start('codex')
    expect(store.snapshot().operations.codex?.phase).toBe('failed')
  })

  it('checks again on reconnect and releases its timer and state listener on cleanup', async () => {
    vi.useFakeTimers()
    const transport = new TestTransport(() => ({ updates: [] }))
    transport.state = 'connecting'
    const store = new ProviderUpdatesStore(transport)
    const stop = store.monitor()
    transport.emitState('open')
    await Promise.resolve()
    await store.refresh()
    expect(transport.requests).toHaveLength(1)
    stop()
    await vi.advanceTimersByTimeAsync(3_600_001)
    transport.emitState('open')
    expect(transport.requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
