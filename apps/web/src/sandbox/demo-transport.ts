import {
  channels,
  methods,
  type ChannelName,
  type DataOf,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from '@harness/contracts'
import type { ConnectionState, Transport } from '../transport.js'
import { DemoServer, type DemoServerOptions } from './demo-server.js'

export type DemoTransportOptions = Omit<DemoServerOptions, 'push'> & {
  /** How long a request takes to answer, like a local socket round trip. */
  latencyMs?: number
}

type Pending = { reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }

const CLOSED = 'Connection to the server was closed.'

/**
 * The App's Transport, answered in memory by a DemoServer instead of a socket.
 * It keeps the real transport's contract: requests wait while connecting,
 * close() fails what is still waiting, and every request, reply and push is
 * checked against the protocol schemas, so the sandbox cannot drift from it.
 */
export class DemoTransport implements Transport {
  readonly server: DemoServer
  #state: ConnectionState = 'closed'
  #closedByUs = false
  #latencyMs: number
  #openTimer: ReturnType<typeof setTimeout> | undefined
  #pending = new Set<Pending>()
  #waiting: Array<() => void> = []
  #stateListeners = new Set<(state: ConnectionState) => void>()
  #channelListeners = new Map<string, Set<(data: unknown) => void>>()

  constructor(options: DemoTransportOptions = {}) {
    const { latencyMs = 25, ...serverOptions } = options
    this.#latencyMs = latencyMs
    this.server = new DemoServer({
      ...serverOptions,
      push: (channel, data) => this.#emit(channel, data),
    })
  }

  get state(): ConnectionState {
    return this.#state
  }

  connect(): void {
    this.#closedByUs = false
    if (this.#state === 'open' || this.#openTimer !== undefined) return
    this.#setState('connecting')
    this.#openTimer = setTimeout(() => {
      this.#openTimer = undefined
      this.#setState('open')
      for (const start of this.#waiting.splice(0)) start()
    }, this.#latencyMs)
  }

  close(): void {
    this.#closedByUs = true
    clearTimeout(this.#openTimer)
    this.#openTimer = undefined
    this.#waiting = []
    for (const pending of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(CLOSED))
    }
    this.#pending.clear()
    this.#setState('closed')
  }

  ensureHealthy(): Promise<void> {
    return Promise.resolve()
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  /** Nothing is lost in memory, so a gap never happens. */
  onSequenceGap(): () => void {
    return () => undefined
  }

  on<C extends ChannelName>(channel: C, listener: (data: DataOf<C>) => void): () => void {
    let listeners = this.#channelListeners.get(channel)
    if (!listeners) {
      listeners = new Set()
      this.#channelListeners.set(channel, listeners)
    }
    const dispatch = (value: unknown) => {
      // SAFETY: The schema for this same channel validates the value before dispatch.
      listener(channels[channel].parse(value) as DataOf<C>)
    }
    listeners.add(dispatch)
    return () => listeners.delete(dispatch)
  }

  request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (this.#closedByUs) return Promise.reject(new Error(CLOSED))
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const pending: Pending = { reject, timer: undefined }
      const start = () => {
        pending.timer = setTimeout(() => {
          this.#pending.delete(pending)
          this.#answer(method, params).then(resolve, reject)
        }, this.#latencyMs)
      }
      this.#pending.add(pending)
      if (this.#state === 'open') start()
      else this.#waiting.push(start)
    })
  }

  async #answer<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    methods[method].params.parse(params)
    const answer = this.server.handle(method, params)
    // A method the sandbox does not model succeeds when its reply is empty, and
    // fails like an unsupported feature otherwise.
    const value = answer === undefined ? {} : await answer
    try {
      // SAFETY: The result schema for this same method validates the value.
      return methods[method].result.parse(value) as ResultOf<M>
    } catch (error) {
      if (answer === undefined) throw new Error(`${method} is not available in the design sandbox.`)
      console.error(`[sandbox] ${method} reply failed validation`, error)
      throw new Error(`The design sandbox sent an invalid reply to ${method}.`)
    }
  }

  #emit<C extends ChannelName>(channel: C, data: DataOf<C>): void {
    if (this.#state !== 'open') return
    for (const listener of this.#channelListeners.get(channel) ?? []) {
      try {
        listener(data)
      } catch (error) {
        console.error(`[sandbox] ${channel} listener failed`, error)
      }
    }
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return
    this.#state = state
    for (const listener of this.#stateListeners) {
      try {
        listener(state)
      } catch (error) {
        console.error('[sandbox] connection state listener failed', error)
      }
    }
  }
}
