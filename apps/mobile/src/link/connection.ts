import { AppState, type AppStateStatus } from 'react-native'
import * as Device from 'expo-device'
import type { ChannelName, DataOf, MethodName, ParamsOf, ResultOf } from '@harness/contracts'
import { TasteLink, type LinkFramesEvent, type LinkStateEvent } from '../../modules/tastecode-link'
import { Store } from '../store'
import { IndeterminateError, ServerError } from './errors'
import { orderedHosts, savePairing, type Pairing } from './pairing'

export { IndeterminateError, ServerError } from './errors'

export type LinkStatus =
  | { phase: 'idle' }
  | { phase: 'connecting'; since: number; error?: string | undefined }
  | { phase: 'open'; host: string; serverName: string; since: number }
  | { phase: 'waiting'; error: string; code: string; retryAt: number }
  /** The computer refused this phone; only pairing again helps. */
  | { phase: 'refused'; error: string; code: string }

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  sent: boolean
}

const MAX_RETRY_MS = 15_000
const HEALTH_INTERVAL_MS = 20_000
const QUIET_BEFORE_CHECK_MS = 25_000
/** How long an attempt someone sees stays on screen, so an instant refusal does not flash. */
const SHOWN_ATTEMPT_MS = 600
const REFUSALS = new Set(['not_paired', 'pairing_expired'])

/**
 * The phone's side of the protocol, over the native encrypted link. Requests
 * made while the link is down wait in a queue and go out on reconnect, the
 * same contract as the desktop's transport.
 */
export class Connection {
  readonly status = new Store<LinkStatus>({ phase: 'idle' })
  #pairing: Pairing | undefined
  #attempt = 0
  #pending = new Map<string, Pending>()
  #queue: Array<{ id: string; frame: string }> = []
  #nextId = 1
  #lastSequence = 0
  #lastFrameAt = 0
  #channels = new Map<string, Set<(data: unknown) => void>>()
  #openListeners = new Set<() => void>()
  #gapListeners = new Set<() => void>()
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #retryDelay = 0
  #healthTimer: ReturnType<typeof setInterval> | undefined
  #appState: string = AppState.currentState ?? 'active'
  #network: string | undefined
  #onPairingChange: (pairing: Pairing) => void = () => {}

  constructor() {
    TasteLink.addListener('onLinkState', (event) => this.#onState(event))
    TasteLink.addListener('onLinkFrames', (event) => this.#onFrames(event))
    TasteLink.addListener('onPathChange', (event) => {
      // The first report is the network the link started on; a repeat of it changes nothing.
      const network = `${event.satisfied} ${event.wifi} ${event.expensive}`
      const changed = this.#network !== undefined && network !== this.#network
      this.#network = network
      if (changed && event.satisfied && this.status.get().phase !== 'open') this.#retry(false)
    })
    AppState.addEventListener('change', (state) => this.#onAppState(state))
  }

  get pairing(): Pairing | undefined {
    return this.#pairing
  }

  /** Called when the link learns something to remember: the device id, the address that worked. */
  onPairingChange(listener: (pairing: Pairing) => void): void {
    this.#onPairingChange = listener
  }

  start(pairing: Pairing): void {
    this.#pairing = pairing
    this.#retryDelay = 0
    this.#connect()
  }

  stop(): void {
    this.#pairing = undefined
    this.#attempt += 1
    clearTimeout(this.#retryTimer)
    clearInterval(this.#healthTimer)
    TasteLink.close()
    this.#rejectAll(new Error('Disconnected from the computer.'))
    this.#queue = []
    this.status.set({ phase: 'idle' })
  }

  /** Tries again now, as Try Again asks; the screens show the attempt. */
  /** Keeps a name the person chose for the computer, or goes back to its own with none. */
  relabel(label: string | undefined): void {
    const pairing = this.#pairing
    if (!pairing) return
    const next: Pairing = { ...pairing }
    if (label) next.label = label
    else delete next.label
    this.#pairing = next
    savePairing(next)
    this.#onPairingChange(next)
  }

  reconnectNow(): void {
    this.#retry(true)
  }

  request<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    timeoutMs = 60_000,
  ): Promise<ResultOf<M>> {
    const id = String(this.#nextId++)
    const frame = JSON.stringify({ id, method, params })
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id)
        this.#pending.delete(id)
        this.#queue = this.#queue.filter((entry) => entry.id !== id)
        reject(
          pending?.sent
            ? new IndeterminateError('The computer did not answer. It may still have done it.')
            : new Error('The computer is not reachable right now.'),
        )
      }, timeoutMs)
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as ResultOf<M>),
        reject,
        timer,
        sent: false,
      })
      this.#send(id, frame)
    })
  }

  on<C extends ChannelName>(channel: C, listener: (data: DataOf<C>) => void): () => void {
    let listeners = this.#channels.get(channel)
    if (!listeners) {
      listeners = new Set()
      this.#channels.set(channel, listeners)
    }
    const dispatch = listener as (data: unknown) => void
    listeners.add(dispatch)
    return () => listeners.delete(dispatch)
  }

  /** Every time the link (re)opens, after queued requests went out. */
  onOpen(listener: () => void): () => void {
    this.#openListeners.add(listener)
    return () => this.#openListeners.delete(listener)
  }

  /** Pushes were missed; whoever shows live state reads it again. */
  onGap(listener: () => void): () => void {
    this.#gapListeners.add(listener)
    return () => this.#gapListeners.delete(listener)
  }

  #send(id: string, frame: string): void {
    if (this.status.get().phase === 'open' && TasteLink.send(frame)) {
      const pending = this.#pending.get(id)
      if (pending) pending.sent = true
      return
    }
    this.#queue.push({ id, frame })
  }

  #retry(shown: boolean): void {
    if (!this.#pairing || this.status.get().phase === 'refused') return
    this.#retryDelay = 0
    this.#connect(shown)
  }

  /**
   * Starts an attempt. One in the background leaves a failure on screen until
   * it opens or fails differently, so the screens do not flicker on every try.
   */
  #connect(shown = false): void {
    const pairing = this.#pairing
    if (!pairing) return
    clearTimeout(this.#retryTimer)
    const previous = this.status.get()
    if (shown || previous.phase !== 'waiting') {
      this.status.set({
        phase: 'connecting',
        since: previous.phase === 'connecting' ? previous.since : Date.now(),
        error:
          previous.phase === 'waiting' || previous.phase === 'connecting'
            ? previous.error
            : undefined,
      })
    }
    const hello = JSON.stringify({
      v: 1,
      name: phoneName(),
      ...(pairing.secret ? { pair: pairing.secret } : {}),
    })
    try {
      this.#attempt = TasteLink.connect({
        key: pairing.key,
        hosts: orderedHosts(pairing),
        port: pairing.port,
        hello,
      })
    } catch (error) {
      this.status.set({
        phase: 'refused',
        error: error instanceof Error ? error.message : String(error),
        code: 'bad_key',
      })
    }
  }

  #onState(event: LinkStateEvent): void {
    if (event.attempt !== this.#attempt) return
    if (event.state === 'open') {
      this.#opened(event.host, event.deviceId, event.serverName)
      return
    }
    clearInterval(this.#healthTimer)
    const previous = this.status.get()
    this.#rejectSent()
    if (REFUSALS.has(event.code) && (event.code === 'not_paired' || this.#pairing?.secret)) {
      this.status.set({ phase: 'refused', error: event.error, code: event.code })
      return
    }
    if (previous.phase === 'open') {
      // A link that dropped while open usually comes straight back.
      this.status.set({ phase: 'connecting', since: Date.now(), error: event.error })
      this.#retryTimer = setTimeout(() => this.#connect(), 300)
      return
    }
    const delay = this.#nextDelay(event.code)
    const shownFor =
      previous.phase === 'connecting' ? Date.now() - previous.since : SHOWN_ATTEMPT_MS
    this.#retryTimer = setTimeout(
      () => {
        this.status.set({
          phase: 'waiting',
          error: event.error,
          code: event.code,
          retryAt: Date.now() + delay,
        })
        this.#retryTimer = setTimeout(() => this.#connect(), delay)
      },
      Math.max(0, SHOWN_ATTEMPT_MS - shownFor),
    )
  }

  #opened(host: string, deviceId: string, serverName: string): void {
    const pairing = this.#pairing
    if (pairing) {
      const next: Pairing = { ...pairing, lastHost: host, name: serverName || pairing.name }
      if (pairing.secret) {
        delete next.secret
        next.deviceId = deviceId
        next.pairedAt = Date.now()
      }
      if (
        next.lastHost !== pairing.lastHost ||
        next.name !== pairing.name ||
        next.secret !== pairing.secret
      ) {
        this.#pairing = next
        savePairing(next)
        this.#onPairingChange(next)
      }
    }
    this.#retryDelay = 0
    this.#lastSequence = 0
    this.#lastFrameAt = Date.now()
    this.status.set({ phase: 'open', host, serverName, since: Date.now() })
    const queued = this.#queue.splice(0)
    for (const entry of queued) {
      if (this.#pending.has(entry.id)) this.#send(entry.id, entry.frame)
    }
    clearInterval(this.#healthTimer)
    this.#healthTimer = setInterval(() => this.#checkHealth(), HEALTH_INTERVAL_MS)
    for (const listener of this.#openListeners) listener()
  }

  #nextDelay(code: string): number {
    if (code === 'disabled' || code === 'local_network_denied') return 10_000
    this.#retryDelay = this.#retryDelay === 0 ? 1_000 : Math.min(this.#retryDelay * 2, MAX_RETRY_MS)
    return this.#retryDelay
  }

  #onFrames(event: LinkFramesEvent): void {
    if (event.attempt !== this.#attempt) return
    this.#lastFrameAt = Date.now()
    for (const raw of event.frames) {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof frame['channel'] === 'string') this.#onPush(frame)
      else if (typeof frame['id'] === 'string') this.#onResponse(frame)
    }
  }

  #onPush(frame: Record<string, unknown>): void {
    const sequence = frame['sequence']
    if (typeof sequence === 'number') {
      if (this.#lastSequence !== 0 && sequence <= this.#lastSequence) return
      const gap = this.#lastSequence !== 0 && sequence !== this.#lastSequence + 1
      this.#lastSequence = sequence
      if (gap) for (const listener of this.#gapListeners) listener()
    }
    const listeners = this.#channels.get(String(frame['channel']))
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(frame['data'])
      } catch (error) {
        console.error(`[link] ${String(frame['channel'])} listener failed`, error)
      }
    }
  }

  #onResponse(frame: Record<string, unknown>): void {
    const id = String(frame['id'])
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    const error = frame['error'] as { message?: string; detail?: string; code?: string } | undefined
    if (error) {
      const message = error.message || 'The computer reported an error.'
      pending.reject(
        new ServerError(error.detail ? `${message} (${error.detail})` : message, error.code),
      )
    } else {
      pending.resolve(frame['result'])
    }
  }

  #rejectSent(): void {
    for (const [id, pending] of this.#pending) {
      if (!pending.sent) continue
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(
        new IndeterminateError('The link to the computer dropped. It may still have done it.'),
      )
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #checkHealth(): void {
    if (this.#appState !== 'active' || this.status.get().phase !== 'open') return
    if (Date.now() - this.#lastFrameAt < QUIET_BEFORE_CHECK_MS) return
    const attempt = this.#attempt
    this.request('system.info', {}, 8_000).catch(() => {
      if (attempt === this.#attempt && this.status.get().phase === 'open') this.#retry(false)
    })
  }

  #onAppState(state: AppStateStatus): void {
    const previous = this.#appState
    this.#appState = state
    if (state !== 'active' || previous === 'active') return
    // Coming back from the background: the socket may have died while suspended.
    if (this.status.get().phase === 'open') {
      this.#lastFrameAt = 0
      this.#checkHealth()
    } else {
      this.#retry(false)
    }
  }
}

function phoneName(): string {
  const name = Device.deviceName
  // Without a special entitlement iOS reports only "iPhone"; the model says more.
  if (name && !/^(iPhone|iPad)$/.test(name)) return name
  return Device.modelName ?? name ?? 'iPhone'
}
