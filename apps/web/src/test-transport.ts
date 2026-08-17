import {
  channels,
  methods,
  type ChannelName,
  type DataOf,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from '@harness/contracts'
import { z } from 'zod'
import type { ConnectionState, Transport } from './transport.js'

const TestBoundarySchema = z.unknown()

export type TestBoundary = z.input<typeof TestBoundarySchema>
export type TestRequestResolver = (
  method: MethodName,
  params: TestBoundary,
) => TestBoundary | Promise<TestBoundary>
export type RecordedRequest = { method: MethodName; params: TestBoundary }

function unhandledRequest(method: MethodName): never {
  throw new Error(`Unhandled test request: ${method}`)
}

export class TestTransport implements Transport {
  state: ConnectionState = 'open'
  readonly requests: RecordedRequest[] = []
  connected = 0
  closed = 0
  healthChecks = 0
  #resolver: TestRequestResolver
  #stateListeners = new Set<(state: ConnectionState) => void>()
  #sequenceGapListeners = new Set<(expected: number, received: number) => void>()
  #channelListeners = new Map<string, Set<(data: TestBoundary) => void>>()

  constructor(resolver: TestRequestResolver = unhandledRequest) {
    this.#resolver = resolver
  }

  connect(): void {
    this.connected += 1
  }

  close(): void {
    this.closed += 1
  }

  ensureHealthy(): Promise<void> {
    this.healthChecks += 1
    return Promise.resolve()
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
    let listeners = this.#channelListeners.get(channel)
    if (!listeners) {
      listeners = new Set()
      this.#channelListeners.set(channel, listeners)
    }
    const dispatch = (value: TestBoundary) => {
      // SAFETY: The schema for this same channel validates the value before dispatch.
      listener(channels[channel].parse(value) as DataOf<C>)
    }
    listeners.add(dispatch)
    return () => listeners.delete(dispatch)
  }

  async request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    this.requests.push({ method, params })
    const value = await this.#resolver(method, params)
    // SAFETY: The result schema for this same method validates the resolver output.
    return methods[method].result.parse(value) as ResultOf<M>
  }

  emit<C extends ChannelName>(channel: C, data: DataOf<C>): void {
    for (const listener of this.#channelListeners.get(channel) ?? []) listener(data)
  }

  emitState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.#stateListeners) listener(state)
  }

  emitSequenceGap(expected: number, received: number): void {
    for (const listener of this.#sequenceGapListeners) listener(expected, received)
  }
}
