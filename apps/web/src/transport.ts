import type { ChannelName, DataOf, MethodName, ParamsOf, ResultOf } from '@harness/contracts'

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
  #queue: string[] = []
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
    this.#send(JSON.stringify({ id, method, params }))
    return promise as Promise<ResultOf<M>>
  }

  #send(payload: string): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(payload)
      return
    }
    this.#queue.push(payload)
  }

  #open(state: ConnectionState): void {
    this.#setState(state)
    const socket = new WebSocket(this.#url)
    this.#socket = socket

    socket.onopen = () => {
      this.#setState('open')
      for (const payload of this.#queue.splice(0)) socket.send(payload)
    }

    socket.onmessage = (event) => this.#receive(String(event.data))

    socket.onclose = () => {
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
      const error = message['error'] as { message?: string; detail?: string } | undefined
      if (error) {
        call.reject(new Error(error.detail ? `${error.message} (${error.detail})` : error.message))
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

    for (const listener of this.#channelListeners.get(channel) ?? []) {
      listener(message['data'])
    }
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return
    this.#state = state
    if (state === 'connecting' || state === 'closed') this.#lastSequence = 0
    for (const listener of this.#stateListeners) listener(state)
  }
}
