import type { ChannelName, DataOf, MethodName, ParamsOf, Push, ResultOf } from '@harness/contracts'
import {
  canCapturePreview,
  cancelPreviewCapture,
  capturePreview,
  reportStartupMilestone,
} from './bridge.js'
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

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  sent: boolean
  validating?: boolean
  validationBytes?: number
}

export const TRANSPORT_LIMITS = {
  requests: 512,
  queuedBytes: 128 * 1024 * 1024,
  bufferedBytes: 128 * 1024 * 1024,
  validationFrames: 2_048,
  validationBytes: 16 * 1024 * 1024,
  responseValidationBytes: 128 * 1024 * 1024,
  requestTimeoutMs: 120_000,
} as const

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
  #queuedBytes = 0
  #nextId = 1
  #lastSequence = 0
  #state: ConnectionState = 'closed'
  #closedByUs = false
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectDelayMs = 0
  #hasOpened = false
  #healthCheck: Promise<void> | undefined
  #validation: TransportValidation | undefined
  #validationLoad: Promise<void> | undefined
  #validationQueue: Array<{ source: WebSocket; channel: string; data: unknown }> = []
  #responses = new Map<string, unknown>()
  #validationBytes = 0
  #responseValidationBytes = 0
  #captures = new Set<string>()

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
    this.#loadValidation()
    this.#open('connecting')
  }

  close(): void {
    this.#closedByUs = true
    this.#clearReconnectTimer()
    this.#socket?.close()
    this.#cancelCaptures()
    // This instance is being discarded; nothing will ever flush the queue or
    // answer in-flight calls. A request left pending here kept its caller's
    // await hanging (and the composer stuck on Stop) until a reload.
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(
        pending.sent
          ? new IndeterminateRequestError(
              'Connection to the server was closed. The operation may have completed.',
            )
          : new Error('Connection to the server was closed.'),
      )
    }
    this.#pending.clear()
    this.#inFlight.clear()
    this.#queue = []
    this.#queuedBytes = 0
    this.#validationQueue = []
    this.#validationBytes = 0
    this.#responseValidationBytes = 0
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
    if (this.#closedByUs) return Promise.reject(new Error('Connection to the server was closed.'))
    if (this.#pending.size >= TRANSPORT_LIMITS.requests) {
      return Promise.reject(
        new Error('Too many requests are waiting for the server. Try again shortly.'),
      )
    }
    const id = String(this.#nextId++)
    const promise = new Promise<ResultOf<M>>((resolve, reject) => {
      const finish = (result: ResultOf<M>) => {
        if (!this.#pending.has(id)) return
        this.#removePending(id)
        resolve(result)
      }
      const fail = (error: Error) => {
        this.#removePending(id)
        reject(error)
      }
      this.#pending.set(id, {
        sent: false,
        timer: setTimeout(() => {
          const sent = this.#pending.get(id)?.sent
          this.#removePending(id)
          const message = sent
            ? 'The server did not reply. The operation may have completed; refresh before trying again.'
            : 'The request expired before it could be sent. Try again when connected.'
          reject(sent ? new IndeterminateRequestError(message) : new Error(message))
          if (sent && !this.#closedByUs) this.#restartSocket()
        }, TRANSPORT_LIMITS.requestTimeoutMs),
        resolve: (value) => {
          if (method === 'projects.list') reportStartupMilestone('projects-frame-parsed')
          const startupResult = parseStartupMethodResult(method, value)
          if (startupResult !== undefined) {
            if (method === 'projects.list') reportStartupMilestone('projects-validated')
            finish(startupResult)
            return
          }
          const validation = this.#validation
          if (validation) {
            try {
              finish(validation.parseMethodResult(method, value))
            } catch (error) {
              fail(asError(error))
            }
            return
          }
          // Only this ID-indexed owner retains the raw reply. A callback per
          // reply would keep it alive after timeout returned its byte budget.
          this.#responses.set(id, value)
          this.#loadValidation()
        },
        reject: fail,
      })
    })
    try {
      this.#send(JSON.stringify({ id, method, params }), id)
    } catch (error) {
      const pending = this.#pending.get(id)
      this.#removePending(id)
      pending?.reject(asError(error))
    }
    return promise
  }

  #removePending(id: string): void {
    const pending = this.#pending.get(id)
    clearTimeout(pending?.timer)
    this.#responseValidationBytes -= pending?.validationBytes ?? 0
    this.#responses.delete(id)
    this.#pending.delete(id)
    this.#inFlight.delete(id)
    const index = this.#queue.findIndex((entry) => entry.id === id)
    if (index >= 0) {
      const [entry] = this.#queue.splice(index, 1)
      this.#queuedBytes -= entry!.payload.length * 2
    }
  }

  #send(payload: string, id?: string): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      if (
        (this.#socket.bufferedAmount ?? 0) + new TextEncoder().encode(payload).byteLength >
        TRANSPORT_LIMITS.bufferedBytes
      ) {
        throw new Error('The connection is busy. Wait for it to recover before trying again.')
      }
      this.#socket.send(payload)
      if (id) {
        this.#inFlight.add(id)
        const pending = this.#pending.get(id)
        if (pending) pending.sent = true
      }
      return
    }
    if (this.#queuedBytes + payload.length * 2 > TRANSPORT_LIMITS.queuedBytes) {
      throw new Error('Too much data is waiting for the server. Try again when connected.')
    }
    this.#queue.push({ id, payload })
    this.#queuedBytes += payload.length * 2
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
      const queued = this.#queue.splice(0)
      this.#queuedBytes = 0
      for (const entry of queued) {
        try {
          this.#send(entry.payload, entry.id)
        } catch (error) {
          if (entry.id) {
            const pending = this.#pending.get(entry.id)
            this.#removePending(entry.id)
            pending?.reject(asError(error))
          }
        }
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
    this.#cancelCaptures()
    this.#validationQueue = []
    this.#validationBytes = 0
    for (const id of this.#inFlight) {
      const call = this.#pending.get(id)
      if (call) {
        call.reject(new IndeterminateRequestError('Connection to the server was lost.'))
      }
    }
    this.#inFlight.clear()
  }

  #cancelCaptures(): void {
    for (const id of this.#captures) void cancelPreviewCapture(id).catch(() => undefined)
    this.#captures.clear()
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
      if (!call || call.validating) return
      call.validating = true
      if ('error' in message) {
        // A frame without a message must not surface as the literal string
        // "undefined" in the notice bar.
        const text = message.error.message || 'The server reported an error.'
        call.reject(new Error(message.error.detail ? `${text} (${message.error.detail})` : text))
      } else {
        const bytes = raw.length * 2
        if (this.#responseValidationBytes + bytes > TRANSPORT_LIMITS.responseValidationBytes) {
          call.reject(
            new IndeterminateRequestError(
              'Too much server data is waiting to be checked. Refresh before trying again.',
            ),
          )
          this.#restartSocket()
          return
        }
        call.validationBytes = bytes
        this.#responseValidationBytes += bytes
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
    const shouldCapture =
      (channel === 'preview.captureRequested' || channel === 'preview.captureCancelled') &&
      canCapturePreview
    if (!shouldCapture && (!listeners || listeners.size === 0)) return

    const validation = this.#validation
    if (validation) {
      this.#dispatchPush(validation, source, channel, data)
      return
    }
    if (
      this.#validationQueue.length >= TRANSPORT_LIMITS.validationFrames ||
      this.#validationBytes + raw.length * 2 > TRANSPORT_LIMITS.validationBytes
    ) {
      this.#restartSocket()
      return
    }
    this.#validationQueue.push({ source, channel, data })
    this.#validationBytes += raw.length * 2
    this.#loadValidation()
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
    if (channel === 'preview.captureCancelled' && canCapturePreview) {
      try {
        const request = validation.parseChannelData('preview.captureCancelled', data)
        this.#captures.delete(request.requestId)
        void cancelPreviewCapture(request.requestId).catch(() => undefined)
      } catch {
        return
      }
    }
    if (channel === 'preview.captureRequested' && canCapturePreview) {
      const request = validation.parsePreviewCaptureRequest(data)
      if (request) {
        if (this.#captures.has(request.requestId)) return
        this.#captures.add(request.requestId)
        parsedData = request
        void capturePreview(request)
          .then((result) => {
            if (this.#socket !== source || !this.#captures.delete(request.requestId)) return
            return this.request('preview.captureResult', result)
          })
          .catch(() => undefined)
          .finally(() => this.#captures.delete(request.requestId))
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

  #loadValidation(): void {
    if (this.#validation || this.#validationLoad) return

    this.#validationLoad = import('./transport-validation.js')
      .then((validation) => {
        this.#validation = validation
        this.#validationLoad = undefined
        const queued = this.#validationQueue.splice(0)
        this.#validationBytes = 0
        for (const push of queued) {
          this.#dispatchPush(validation, push.source, push.channel, push.data)
        }
        // Timeout, disconnect and close remove entries from this map. The
        // one loader continuation only parses replies that still have owners.
        for (const [id, value] of this.#responses) {
          this.#responses.delete(id)
          this.#pending.get(id)?.resolve(value)
        }
      })
      .catch((error: unknown) => {
        this.#validationLoad = undefined
        this.#validationQueue = []
        this.#validationBytes = 0
        for (const id of this.#responses.keys()) this.#pending.get(id)?.reject(asError(error))
      })
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return
    this.#state = state
    for (const listener of this.#stateListeners) listener(state)
  }
}

export const Transport = WebSocketTransport
