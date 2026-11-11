import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from '@harness/contracts'
import type { Transport } from './transport.js'
import { UsageResetController, usageResetAt } from './usage-reset.js'

const NOW = 1_800_000_000_000
const window = (resetsAt?: number) => ({ label: 'Session', usedPercent: 100, resetsAt })
const session = { id: 'limited', provider: 'codex' as const, running: false }

describe('resume at usage reset', () => {
  const stops: Array<() => void> = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop())
    vi.useRealTimers()
  })

  function setup(provider: ProviderId = 'codex') {
    let saved = '[]'
    const storage = {
      read: () => saved,
      write: (value: string) => {
        saved = value
      },
    }
    const listeners = new Map<string, (data: unknown) => void>()
    const report = vi.fn()
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'thread.settings') return { model: 'chosen-model' }
      if (method === 'projects.list')
        return { projects: [{ sessions: [{ ...session, provider }] }] }
      if (method === 'usage.summary') return { limits: [] }
      if (method === 'thread.history')
        return {
          running: false,
          events: [
            {
              seq: 1,
              event: { type: 'item.completed', item: { id: 'ask', type: 'message', role: 'user' } },
            },
            { seq: 2, event: { type: 'turn.completed', turnId: 'failed-turn', status: 'failed' } },
          ],
        }
      return {}
    })
    const transport = {
      state: 'open',
      request,
      onState: () => () => {},
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      },
    } as unknown as Transport
    const controller = new UsageResetController(transport, storage, report)
    stops.push(controller.start())
    return { controller, transport, request, storage, report, listeners }
  }

  it('waits for every exhausted window and does not invent unknown reset times', () => {
    expect(usageResetAt([window(NOW + 1000), window(NOW + 5000)], NOW)).toBe(NOW + 5000)
    expect(usageResetAt([window(NOW + 1000), window()], NOW)).toBeUndefined()
    expect(usageResetAt([window(NOW - 1)], NOW)).toBeUndefined()
    expect(usageResetAt([{ ...window(), valueLabel: '$0.00' }], NOW)).toBeUndefined()
  })

  it('snoozes only on opt-in and continues the same chat and model exactly once', async () => {
    const { controller, request } = setup()
    await controller.schedule(session, 'ask', NOW + 1000)
    expect(request).toHaveBeenCalledWith('thread.snooze', {
      threadId: 'limited',
      wakeAt: NOW + 1000,
    })
    expect(request.mock.calls.some(([method]) => method === 'thread.sendTurn')).toBe(false)
    vi.setSystemTime(NOW + 1000)
    await controller.check()
    await controller.check()
    expect(request.mock.calls.filter(([method]) => method === 'thread.sendTurn')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith(
      'thread.sendTurn',
      expect.objectContaining({
        threadId: 'limited',
        model: 'chosen-model',
        clientSubmissionId: expect.any(String),
      }),
    )
    expect(controller.snapshot()).toEqual([])
  })

  it('restores schedules after reload and catches up after sleep', async () => {
    const { controller, request, transport, storage, report } = setup()
    await controller.schedule(session, 'ask', NOW + 1000)
    stops.pop()!()
    const restored = new UsageResetController(transport, storage, report)
    stops.push(restored.start())
    vi.setSystemTime(NOW + 100_000)
    await restored.check()
    expect(request.mock.calls.filter(([method]) => method === 'thread.sendTurn')).toHaveLength(1)
  })

  it.each(['cancel', 'turn', 'model', 'settle', 'unsnooze'])(
    'cancels when the user chooses %s',
    async (action) => {
      const { controller, request, listeners } = setup()
      await controller.schedule(session, 'ask', NOW + 1000)
      if (action === 'cancel') controller.cancel('limited')
      if (action === 'turn')
        listeners.get('thread.event')!({ threadId: 'limited', event: { type: 'turn.started' } })
      if (action === 'model')
        listeners.get('thread.settings')!({ threadId: 'limited', settings: { model: 'other' } })
      if (action === 'settle' || action === 'unsnooze')
        listeners.get('thread.lifecycle')!({
          threadId: 'limited',
          lifecycle: { state: action === 'settle' ? 'settled' : 'active' },
        })
      vi.setSystemTime(NOW + 1000)
      await controller.check()
      expect(controller.snapshot()).toEqual([])
      expect(request.mock.calls.some(([method]) => method === 'thread.sendTurn')).toBe(false)
    },
  )

  it.each(['provider', 'model', 'new turn', 'deleted', 'account', 'connection'])(
    'rechecks %s before a background continuation',
    async (change) => {
      const { controller, request } = setup()
      await controller.schedule(session, 'ask', NOW + 1000)
      const original = request.getMockImplementation()!
      request.mockImplementation(async (method) => {
        if (method === 'projects.list')
          return {
            projects: [
              {
                sessions:
                  change === 'deleted'
                    ? []
                    : [
                        {
                          ...session,
                          ...(change === 'provider' ? { provider: 'grok' } : {}),
                          ...(change === 'account' ? { accountId: 'work' } : {}),
                          ...(change === 'connection' ? { connectionId: 'other' } : {}),
                        },
                      ],
              },
            ],
          }
        if (change === 'model' && method === 'thread.settings') return { model: 'other' }
        if (change === 'new turn' && method === 'thread.history')
          return { running: true, events: [] }
        return original(method)
      })
      vi.setSystemTime(NOW + 1000)
      await controller.check()
      expect(controller.snapshot()).toEqual([])
      expect(request.mock.calls.some(([method]) => method === 'thread.sendTurn')).toBe(false)
    },
  )

  it('uses the same shared flow for a direct API provider', async () => {
    const { controller, request } = setup('api')
    await controller.schedule({ ...session, provider: 'api' }, 'ask', NOW + 1000)
    vi.setSystemTime(NOW + 1000)
    await controller.check()
    expect(request).toHaveBeenCalledWith(
      'usage.summary',
      expect.objectContaining({ provider: 'api' }),
    )
    expect(request.mock.calls.filter(([method]) => method === 'thread.sendTurn')).toHaveLength(1)
  })

  it('postpones continuation when refreshed usage reports a later exhausted window', async () => {
    const { controller, request, listeners } = setup()
    await controller.schedule(session, 'ask', NOW + 1000)
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) =>
      method === 'usage.summary' ? { limits: [window(NOW + 5000)] } : original(method),
    )
    vi.setSystemTime(NOW + 1000)
    await controller.check()
    expect(controller.snapshot()[0]?.resetsAt).toBe(NOW + 5000)
    listeners.get('thread.lifecycle')!({
      threadId: 'limited',
      lifecycle: { state: 'snoozed', wakeAt: NOW + 5000 },
    })
    expect(controller.snapshot()).toHaveLength(1)
    expect(request.mock.calls.some(([method]) => method === 'thread.sendTurn')).toBe(false)
  })

  it.each([
    ['could not be read', { status: 'unavailable', reason: 'failed' }, 0],
    ['were not read yet by an older server', { status: 'unavailable' }, 0],
    ['are not reported by the provider', { status: 'unavailable', reason: 'unsupported' }, 1],
    ['do not exist for the plan', { status: 'unavailable', reason: 'noPlan' }, 1],
  ])('waits or continues at the reset when limits %s', async (_, limitSource, sends) => {
    const { controller, request } = setup()
    await controller.schedule(session, 'ask', NOW + 1000)
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) =>
      method === 'usage.summary'
        ? { limits: [], limitSource: { provider: 'codex', ...limitSource } }
        : original(method),
    )
    vi.setSystemTime(NOW + 1000)
    await controller.check()
    expect(request.mock.calls.filter(([method]) => method === 'thread.sendTurn')).toHaveLength(
      sends,
    )
    expect(controller.snapshot()).toHaveLength(sends ? 0 : 1)
  })

  it('does not duplicate a continuation claimed by another window', async () => {
    const { controller, transport, storage, report, request } = setup()
    await controller.schedule(session, 'ask', NOW + 1000)
    const other = new UsageResetController(transport, storage, report)
    stops.push(other.start())
    vi.setSystemTime(NOW + 1000)
    await controller.check()
    await other.check()
    expect(request.mock.calls.filter(([method]) => method === 'thread.sendTurn')).toHaveLength(1)
  })

  it('keeps what another window scheduled when this one schedules a chat', async () => {
    const { controller, transport, storage, report } = setup()
    const other = new UsageResetController(transport, storage, report)
    stops.push(other.start())
    await controller.schedule(session, 'ask', NOW + 1000)
    await other.schedule({ ...session, id: 'second' }, 'ask', NOW + 2000)
    const stored = () =>
      (JSON.parse(storage.read()) as Array<{ threadId: string }>).map(({ threadId }) => threadId)
    expect(stored()).toEqual(['limited', 'second'])

    // A cancel in the first window leaves the second window's chat scheduled.
    controller.cancel('limited')
    expect(stored()).toEqual(['second'])
    await controller.check()
    expect(controller.snapshot().map(({ threadId }) => threadId)).toEqual(['second'])
  })

  it('undoes the snooze if the schedule cannot be saved', async () => {
    const { controller, storage, request } = setup()
    vi.spyOn(storage, 'write').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    await expect(controller.schedule(session, 'ask', NOW + 1000)).rejects.toThrow(
      'Storage unavailable',
    )
    expect(request).toHaveBeenCalledWith('thread.unsnooze', { threadId: 'limited' })
    expect(controller.snapshot()).toEqual([])
  })

  it('waits while disconnected, and consumes a rejected send without retrying it', async () => {
    const { controller, request, transport, report } = setup()
    await controller.schedule(session, 'ask', NOW + 1000)
    vi.setSystemTime(NOW + 1000)
    Object.assign(transport, { state: 'reconnecting' })
    await controller.check()
    expect(controller.snapshot()).toHaveLength(1)
    Object.assign(transport, { state: 'open' })
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) => {
      if (method === 'thread.sendTurn') throw new Error('Connection lost')
      return original(method)
    })
    await controller.check()
    await controller.check()
    expect(report).toHaveBeenCalledWith(expect.stringContaining('Connection lost'))
    expect(request.mock.calls.filter(([method]) => method === 'thread.sendTurn')).toHaveLength(1)
  })
})
