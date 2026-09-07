import type { ChannelName, DataOf, MethodName, ParamsOf, Push, ResultOf } from '@harness/contracts'
import { canCapturePreview, capturePreview, reportStartupMilestone } from './bridge.js'
import { parseStartupMethodResult } from './transport-startup-validation.js'

type WireError = { message?: string; detail?: string }
type WireResponse = { id: string; result: unknown } | { id: string; error: WireError }
type IncomingFrame = { kind: 'response'; data: WireResponse } | { kind: 'push'; data: Push }
type TransportValidation = typeof import('./transport-validation.js')

export function parseIncomingFrame(raw: string): IncomingFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }

  // Pushes dominate while an agent streams. Their `channel` key is disjoint
  // from request responses, so do not make every delta fail response parsing
  // before validating the schema it actually uses.
  if (typeof value === 'object' && value !== null && 'channel' in value) {
    const push = parsePushFrame(value)
    return push ? { kind: 'push', data: push } : undefined
  }
  const response = parseResponseFrame(value)
  return response ? { kind: 'response', data: response } : undefined
}

function parsePushFrame(value: object & Record<'channel', unknown>): Push | undefined {
  const frame = value as Record<string, unknown>
  if (
    typeof frame['channel'] !== 'string' ||
    typeof frame['sequence'] !== 'number' ||
    !Number.isFinite(frame['sequence']) ||
    !('data' in frame)
  ) {
    return undefined
  }
  return { channel: frame['channel'], sequence: frame['sequence'], data: frame['data'] }
}

export function parseResponseFrame(value: unknown): WireResponse | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string') return undefined
  if ('result' in value) return { id: value['id'], result: value['result'] }
  const error = value['error']
  if (!isRecord(error)) return undefined

  const message = error['message']
  const detail = error['detail']
  const legacyError =
    (message === undefined || (typeof message === 'string' && message.length > 0)) &&
    (detail === undefined || (typeof detail === 'string' && detail.length > 0))
  const canonicalError =
    isWireErrorCode(error['code']) &&
    typeof message === 'string' &&
    (detail === undefined || typeof detail === 'string')
  if (!legacyError && !canonicalError) return undefined

  return {
    id: value['id'],
    error: {
      ...(typeof message === 'string' ? { message } : {}),
      ...(typeof detail === 'string' ? { detail } : {}),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWireErrorCode(value: unknown): boolean {
  return (
    value === 'bad_request' ||
    value === 'forbidden' ||
    value === 'not_found' ||
    value === 'provider_unavailable' ||
    value === 'stale_snapshot' ||
    value === 'internal'
  )
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('The server returned invalid data.')
}

/**
 * Client side of the wire protocol.
 *
 * An explicit state machine rather than a bare WebSocket: requests made while
 * disconnected are queued and flushed on reconnect, so the UI never has to know
 * whether the socket happens to be up right now.
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface Transport {
  readonly state: ConnectionState
  connect(): void
  close(): void
  ensureHealthy(timeoutMs?: number): Promise<void>
  onState(listener: (state: ConnectionState) => void): () => void
  onSequenceGap(listener: (expected: number, received: number) => void): () => void
  on<C extends ChannelName>(channel: C, listener: (data: DataOf<C>) => void): () => void
  request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** The server may have accepted a transmitted mutation before its reply was lost. */
export class IndeterminateRequestError extends Error {
  override name = 'IndeterminateRequestError'
}

class WebSocketTransport implements Transport {
  #url: string
  #socket: WebSocket | undefined
  #pending = new Map<string, Pending>()
  /** Ids actually transmitted on the current socket — lost if it drops. */
  #inFlight = new Set<string>()
  #queue: Array<{ id: string | undefined; payload: string }> = []
  #nextId = 1
  #lastSequence = 0
  #state: ConnectionState = 'closed'
  #closedByUs = false
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectDelayMs = 0
  #hasOpened = false
  #healthCheck: Promise<void> | undefined
  #validation: TransportValidation | undefined
  #validationLoad: Promise<TransportValidation> | undefined
  #validationQueue: Array<{ source: WebSocket; channel: string; data: unknown }> = []

  #stateListeners = new Set<(s: ConnectionState) => void>()
  #sequenceGapListeners = new Set<(expected: number, received: number) => void>()
  #channelListeners = new Map<string, Set<(data: unknown) => void>>()

  constructor(url: string) {
    this.#url = url
  }

  get state(): ConnectionState {
    return this.#state
  }

  connect(): void {
    this.#closedByUs = false
    this.#clearReconnectTimer()
    // React starts the transport from an effect, after the first screen can
    // paint. Fetch the full protocol validators then instead of making their
    // schemas and Zod block evaluation of the launch bundle.
    void this.#loadValidation().catch(() => undefined)
    this.#open('connecting')
  }

  close(): void {
    this.#closedByUs = true
    this.#clearReconnectTimer()
    this.#socket?.close()
    // This instance is being discarded; nothing will ever flush the queue or
    // answer in-flight calls. A request left pending here kept its caller's
    // await hanging (and the composer stuck on Stop) until a reload.
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('Connection to the server was closed.'))
    }
    this.#pending.clear()
    this.#inFlight.clear()
    this.#queue = []
    this.#validationQueue = []
    this.#setState('closed')
  }

  /**
   * Browser sockets can remain OPEN after a laptop wakes even though the TCP
   * connection underneath is gone. A cheap loopback request confirms liveness;
   * if it cannot answer promptly, replace the socket instead of leaving every
   * later request stranded on a half-dead connection.
   */
  ensureHealthy(timeoutMs = 500): Promise<void> {
    if (this.#closedByUs || this.#state === 'closed' || this.#state === 'connecting') {
      return Promise.resolve()
    }
    if (this.#state === 'reconnecting') {
      if (this.#socket?.readyState !== WebSocket.CONNECTING) this.#scheduleReconnect(true)
      return Promise.resolve()
    }
    if (this.#healthCheck) return this.#healthCheck

    const socket = this.#socket
    let timer: ReturnType<typeof setTimeout> | undefined
    let checking!: Promise<void>
    checking = Promise.race([
      this.request('system.info', {}).then(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Connection health check timed out.')), timeoutMs)
      }),
    ])
      .catch(() => {
        if (!this.#closedByUs && this.#socket === socket) this.#restartSocket()
      })
      .finally(() => {
        clearTimeout(timer)
        if (this.#healthCheck === checking) this.#healthCheck = undefined
      })
    this.#healthCheck = checking
    return checking
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  onSequenceGap(listener: (expected: number, received: number) => void): () => void {
    this.#sequenceGapListeners.add(listener)
    return () => this.#sequenceGapListeners.delete(listener)
  }

  on<C extends ChannelName>(channel: C, listener: (data: DataOf<C>) => void): () => void {
    let set = this.#channelListeners.get(channel)
    if (!set) {
      set = new Set()
      this.#channelListeners.set(channel, set)
    }
    const dispatch = listener as (data: unknown) => void
    set.add(dispatch)
    return () => set.delete(dispatch)
  }

  request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const id = String(this.#nextId++)
    const promise = new Promise<ResultOf<M>>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => {
          if (method === 'projects.list') reportStartupMilestone('projects-frame-parsed')
          const startupResult = parseStartupMethodResult(method, value)
          if (startupResult !== undefined) {
            if (method === 'projects.list') reportStartupMilestone('projects-validated')
            resolve(startupResult)
            return
          }
          const validation = this.#validation
          if (validation) {
            try {
              resolve(validation.parseMethodResult(method, value))
            } catch (error) {
              reject(asError(error))
            }
            return
          }
          void this.#loadValidation()
            .then((loaded) => resolve(loaded.parseMethodResult(method, value)))
            .catch((error: unknown) => reject(asError(error)))
        },
        reject,
      })
    })
    this.#send(JSON.stringify({ id, method, params }), id)
    return promise
  }

  #send(payload: string, id?: string): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(payload)
      if (id) this.#inFlight.add(id)
      return
    }
    this.#queue.push({ id, payload })
  }

  #open(state: ConnectionState): void {
    if (this.#closedByUs) return
    this.#clearReconnectTimer()
    this.#setState(state)
    // Sequence numbers are per connection, so a new socket restarts at 1.
    // Carrying the old counter across a reconnect made the gap detector fire
    // on every successful reconnect — a false alarm that would have trained us
    // to ignore the one warning that actually matters.
    this.#lastSequence = 0
    const socket = new WebSocket(this.#url)
    this.#socket = socket

    socket.onopen = () => {
      // Same replaced-socket guard as onmessage/onclose: an orphan socket
      // must not flush the queue into a connection whose replies are dropped.
      if (this.#socket !== socket) return
      this.#hasOpened = true
      for (const entry of this.#queue.splice(0)) {
        socket.send(entry.payload)
        if (entry.id) this.#inFlight.add(entry.id)
      }
      // State listeners may immediately issue resync reads. Announce the open
      // socket only after older queued mutations are on the wire, preserving
      // request order across the disconnect.
      this.#setState('open')
      void this.request('client.capabilities', { previewCapture: canCapturePreview }).catch(
        () => undefined,
      )
    }

    socket.onmessage = (event) => {
      // A replaced socket can still deliver frames while it finishes closing.
      // The server broadcasts to every open connection, so without this guard
      // each push is applied twice and the thread shows duplicate messages.
      if (this.#socket !== socket) return
      // Reset only after the server actually speaks. A rejected WebSocket can
      // briefly open before an auth close; resetting in onopen made that case
      // reconnect in a zero-delay loop forever.
      this.#reconnectDelayMs = 0
      this.#receive(String(event.data), socket)
    }

    socket.onclose = () => {
      if (this.#socket !== socket) return
      // Calls already transmitted on this socket can never be answered — the
      // server's reply died with the connection. Leaving them pending is how
      // a session got stuck at "starting" forever. Requests still queued
      // survive and flush on reconnect.
      this.#socket = undefined
      this.#rejectInFlight()
      if (this.#closedByUs) return
      this.#scheduleReconnect()
    }
  }

  #restartSocket(): void {
    const socket = this.#socket
    this.#socket = undefined
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    this.#rejectInFlight()
    if (!this.#closedByUs) this.#scheduleReconnect(true)
  }

  #rejectInFlight(): void {
    for (const id of this.#inFlight) {
      const call = this.#pending.get(id)
      if (call) {
        this.#pending.delete(id)
        call.reject(new IndeterminateRequestError('Connection to the server was lost.'))
      }
    }
    this.#inFlight.clear()
  }

  #scheduleReconnect(immediate = false): void {
    if (this.#closedByUs) return
    this.#clearReconnectTimer()
    const coldStart = !this.#hasOpened
    this.#setState(coldStart ? 'connecting' : 'reconnecting')
    const delay = immediate
      ? 0
      : coldStart
        ? Math.min(this.#reconnectDelayMs, 100)
        : this.#reconnectDelayMs
    if (this.#reconnectDelayMs === 0) this.#reconnectDelayMs = 100
    else if (!immediate) this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, 1_000)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#open(coldStart ? 'connecting' : 'reconnecting')
    }, delay)
  }

  #clearReconnectTimer(): void {
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #receive(raw: string, source: WebSocket): void {
    const frame = parseIncomingFrame(raw)
    if (!frame) return
    if (frame.kind === 'response') {
      const message = frame.data
      const call = this.#pending.get(message.id)
      if (!call) return
      this.#pending.delete(message.id)
      this.#inFlight.delete(message.id)
      if ('error' in message) {
        // A frame without a message must not surface as the literal string
        // "undefined" in the notice bar.
        const text = message.error.message || 'The server reported an error.'
        call.reject(new Error(message.error.detail ? `${text} (${message.error.detail})` : text))
      } else {
        call.resolve(message.result)
      }
      return
    }

    const { channel, sequence } = frame.data
    const data = frame.data.data

    const expected = this.#lastSequence + 1
    if (this.#lastSequence !== 0 && sequence <= this.#lastSequence) {
      console.warn(`[transport] ignored stale push: last ${this.#lastSequence}, got ${sequence}`)
      return
    }
    // A forward gap means durable pushes were missed. Tell the owner to
    // resync instead of only logging state divergence it cannot repair.
    if (this.#lastSequence !== 0 && sequence !== expected) {
      console.warn(`[transport] push gap: expected ${expected}, got ${sequence}`)
      for (const listener of this.#sequenceGapListeners) listener(expected, sequence)
    }
    this.#lastSequence = sequence

    const listeners = this.#channelListeners.get(channel)
    const shouldCapture = channel === 'preview.captureRequested' && canCapturePreview
    if (!shouldCapture && (!listeners || listeners.size === 0)) return

    const validation = this.#validation
    if (validation) {
      this.#dispatchPush(validation, source, channel, data)
      return
    }
    this.#validationQueue.push({ source, channel, data })
    void this.#loadValidation().catch(() => undefined)
  }

  #dispatchPush(
    validation: TransportValidation,
    source: WebSocket,
    channel: string,
    data: unknown,
  ): void {
    // A validator chunk can finish loading after a health check replaced the
    // socket. Do not let its queued frames leak into the new connection.
    if (this.#socket !== source || this.#closedByUs) return

    let parsedData: unknown
    if (channel === 'preview.captureRequested' && canCapturePreview) {
      const request = validation.parsePreviewCaptureRequest(data)
      if (request) {
        parsedData = request
        void capturePreview(request)
          .then((result) => this.request('preview.captureResult', result))
          .catch(() => undefined)
      }
    }

    const listeners = this.#channelListeners.get(channel)
    if (!listeners || listeners.size === 0) return
    try {
      parsedData ??= validation.parseChannelData(channel as ChannelName, data)
    } catch {
      return
    }
    for (const listener of listeners) listener(parsedData)
  }

  #loadValidation(): Promise<TransportValidation> {
    if (this.#validation) return Promise.resolve(this.#validation)
    if (this.#validationLoad) return this.#validationLoad

    const loading = import('./transport-validation.js').then(
      (validation) => {
        this.#validation = validation
        this.#validationLoad = undefined
        const queued = this.#validationQueue.splice(0)
        for (const push of queued) {
          this.#dispatchPush(validation, push.source, push.channel, push.data)
        }
        return validation
      },
      (error: unknown) => {
        this.#validationLoad = undefined
        this.#validationQueue = []
        throw error
      },
    )
    this.#validationLoad = loading
    return loading
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return
    this.#state = state
    for (const listener of this.#stateListeners) listener(state)
  }
}

export const Transport = WebSocketTransport
