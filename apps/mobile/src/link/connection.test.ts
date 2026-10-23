import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkStatus } from './connection'

const native = vi.hoisted(() => ({
  listeners: new Map<string, (event: never) => void>(),
  attempts: [] as number[],
  emit(name: string, event: unknown): void {
    native.listeners.get(name)?.(event as never)
  },
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
}))
vi.mock('expo-device', () => ({ deviceName: 'Test Phone', modelName: 'iPhone' }))
vi.mock('../../modules/tastecode-link', () => ({
  TasteLink: {
    addListener: (name: string, listener: (event: never) => void) => {
      native.listeners.set(name, listener)
      return { remove: () => native.listeners.delete(name) }
    },
    connect: () => {
      native.attempts.push(Date.now())
      return native.attempts.length
    },
    send: () => false,
    close: () => undefined,
    writePairing: () => undefined,
  },
}))

const { Connection } = await import('./connection')

const pairing = { name: 'Mac', key: 'k', port: 4317, hosts: ['192.168.1.2'] }

/** The computer is up but nothing listens on the port: every attempt is refused at once. */
function refuse(): void {
  native.emit('onLinkState', {
    attempt: native.attempts.length,
    state: 'failed',
    error: 'The computer is not accepting phone links.',
    code: 'refused',
  })
}

function watch(connection: InstanceType<typeof Connection>): LinkStatus['phase'][] {
  const phases: LinkStatus['phase'][] = []
  connection.status.subscribe(() => phases.push(connection.status.get().phase))
  return phases
}

let answered = 0

/** Refuses every attempt so far, and every one that starts within the given time. */
async function refuseFor(ms: number, step = 50): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    while (answered < native.attempts.length) {
      answered += 1
      refuse()
    }
    await vi.advanceTimersByTimeAsync(step)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  native.attempts = []
  answered = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the link while the computer refuses it', () => {
  it('keeps the failure on screen while it tries again in the background', async () => {
    const connection = new Connection()
    connection.start(pairing)
    const phases = watch(connection)
    await refuseFor(30_000)
    expect(native.attempts.length).toBeGreaterThan(3)
    expect(phases.filter((phase) => phase !== 'waiting')).toEqual([])
    expect(connection.status.get().phase).toBe('waiting')
    connection.stop()
  })

  it('backs off even when the phone reports the same network again and again', async () => {
    const connection = new Connection()
    connection.start(pairing)
    const network = { satisfied: true, wifi: true, expensive: false }
    native.emit('onPathChange', network)
    const reports = setInterval(() => native.emit('onPathChange', network), 1_000)
    await refuseFor(20_000)
    clearInterval(reports)
    // One second, then two, four, eight: not one attempt a second.
    expect(native.attempts.length).toBeLessThanOrEqual(6)
    connection.stop()
  })

  it('tries again at once on a new network', async () => {
    const connection = new Connection()
    connection.start(pairing)
    native.emit('onPathChange', { satisfied: true, wifi: true, expensive: false })
    await refuseFor(20_000)
    const before = native.attempts.length
    native.emit('onPathChange', { satisfied: true, wifi: false, expensive: true })
    expect(native.attempts.length).toBe(before + 1)
    connection.stop()
  })

  it('shows Try Again working for a moment, even when the refusal is instant', async () => {
    const connection = new Connection()
    connection.start(pairing)
    await refuseFor(2_000)
    connection.reconnectNow()
    expect(connection.status.get().phase).toBe('connecting')
    refuse()
    await vi.advanceTimersByTimeAsync(300)
    expect(connection.status.get().phase).toBe('connecting')
    await vi.advanceTimersByTimeAsync(400)
    expect(connection.status.get()).toMatchObject({
      phase: 'waiting',
      error: 'The computer is not accepting phone links.',
    })
    connection.stop()
  })
})

describe('a name chosen for the computer', () => {
  it('stays when the computer reports its own name, and goes with an empty one', () => {
    const connection = new Connection()
    const saved: Array<Record<string, unknown>> = []
    connection.onPairingChange((next) => saved.push(next))
    connection.start(pairing)
    connection.relabel('Desk')
    native.emit('onLinkState', {
      attempt: native.attempts.length,
      state: 'open',
      host: '192.168.1.2',
      deviceId: 'd',
      serverName: 'Mac Studio',
    })
    expect(saved.at(-1)).toMatchObject({ label: 'Desk', name: 'Mac Studio' })
    connection.relabel(undefined)
    expect(saved.at(-1)).not.toHaveProperty('label')
    connection.stop()
  })
})
