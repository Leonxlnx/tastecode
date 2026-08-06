import {
  PreviewCaptureRequestSchema,
  type ChannelName,
  type DataOf,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from '@harness/contracts'
import { canCapturePreview, capturePreview } from './bridge.js'

/**
 * Client side of the wire protocol.
 *
 * An explicit state machine rather than a bare WebSocket: requests made while
 * disconnected are queued and flushed on reconnect, so the UI never has to know
 * whether the socket happens to be up right now.
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class Transport {
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

  #stateListeners = new Set<(s: ConnectionState) => void>()
  #channelListeners = new Map<string, Set<(data: unknown) => void>>()

  constructor(url: string) {
    this.#url = url
  }

  get state(): ConnectionState {
    return this.#state
  }

  connect(): void {
    this.#closedByUs = false
    this.#open('connecting')
  }

  close(): void {
    this.#closedByUs = true
    this.#socket?.close()
    this.#setState('closed')
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  on<C extends ChannelName>(channel: C, listener: (data: DataOf<C>) => void): () => void {
    let set = this.#channelListeners.get(channel)
    if (!set) {
      set = new Set()
      this.#channelListeners.set(channel, set)
    }
    set.add(listener as (data: unknown) => void)
    return () => set.delete(listener as (data: unknown) => void)
  }

  request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const id = String(this.#nextId++)
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.#send(JSON.stringify({ id, method, params }), id)
    return promise as Promise<ResultOf<M>>
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
    this.#setState(state)
    // Sequence numbers are per connection, so a new socket restarts at 1.
    // Carrying the old counter across a reconnect made the gap detector fire
    // on every successful reconnect — a false alarm that would have trained us
    // to ignore the one warning that actually matters.
    this.#lastSequence = 0
    const socket = new WebSocket(this.#url)
    this.#socket = socket

    socket.onopen = () => {
      this.#setState('open')
      for (const entry of this.#queue.splice(0)) {
        socket.send(entry.payload)
        if (entry.id) this.#inFlight.add(entry.id)
      }
      void this.request('client.capabilities', { previewCapture: canCapturePreview }).catch(
        () => undefined,
      )
    }

    socket.onmessage = (event) => {
      // A replaced socket can still deliver frames while it finishes closing.
      // The server broadcasts to every open connection, so without this guard
      // each push is applied twice and the thread shows duplicate messages.
      if (this.#socket !== socket) return
      this.#receive(String(event.data))
    }

    socket.onclose = () => {
      if (this.#socket !== socket) return
      // Calls already transmitted on this socket can never be answered — the
      // server's reply died with the connection. Leaving them pending is how
      // a session got stuck at "starting" forever. Requests still queued
      // survive and flush on reconnect.
      for (const id of this.#inFlight) {
        const call = this.#pending.get(id)
        if (call) {
          this.#pending.delete(id)
          call.reject(new Error('Connection to the server was lost.'))
        }
      }
      this.#inFlight.clear()
      if (this.#closedByUs) return
      this.#setState('reconnecting')
      // Fixed backoff is fine for a loopback connection to a server we own.
      setTimeout(() => this.#open('reconnecting'), 500)
    }
  }

  #receive(raw: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    const id = message['id']
    if (typeof id === 'string') {
      const call = this.#pending.get(id)
      if (!call) return
      this.#pending.delete(id)
      this.#inFlight.delete(id)
      const error = message['error'] as { message?: string; detail?: string } | undefined
      if (error) {
        // A frame without a message must not surface as the literal string
        // "undefined" in the notice bar.
        const text = error.message ?? 'The server reported an error.'
        call.reject(new Error(error.detail ? `${text} (${error.detail})` : text))
      } else {
        call.resolve(message['result'])
      }
      return
    }

    const channel = message['channel']
    const sequence = message['sequence']
    if (typeof channel !== 'string' || typeof sequence !== 'number') return

    // A gap means we missed a push. Loud, because silently diverging from the
    // server is the bug you cannot reproduce later.
    if (this.#lastSequence !== 0 && sequence !== this.#lastSequence + 1) {
      console.warn(`[transport] push gap: expected ${this.#lastSequence + 1}, got ${sequence}`)
    }
    this.#lastSequence = sequence

    if (channel === 'preview.captureRequested' && canCapturePreview) {
      const request = PreviewCaptureRequestSchema.safeParse(message['data'])
      if (request.success) {
        void capturePreview(request.data)
          .then((result) => this.request('preview.captureResult', result))
          .catch(() => undefined)
      }
    }

    for (const listener of this.#channelListeners.get(channel) ?? []) {
      listener(message['data'])
    }
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return
    this.#state = state
    for (const listener of this.#stateListeners) listener(state)
  }
}
