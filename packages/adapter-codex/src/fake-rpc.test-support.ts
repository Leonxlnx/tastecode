import {
  JsonRpcValueSchema,
  type JsonRpcInput,
  type JsonRpcRequestOptions,
  type JsonRpcValue,
  type ParsedJsonRpcRequestOptions,
  type ServerRequestHandler,
} from '@harness/proc'
import type { CodexRpc } from './adapter.js'

export type RecordedRpcCall = {
  method: string
  params: JsonRpcValue | undefined
  timeoutMs?: number
}

type FakeResponse = JsonRpcValue | undefined
type FakeHandler = (
  method: string,
  params: JsonRpcValue | undefined,
) => FakeResponse | Promise<FakeResponse>

export class FakeCodexRpc implements CodexRpc {
  readonly calls: RecordedRpcCall[] = []
  disposals = 0
  #handler: FakeHandler
  #notification: (method: string, params: JsonRpcValue | undefined) => void = () => {}
  #serverRequest: ServerRequestHandler = (_method, _params, respond) => respond(null)
  #stderr: (text: string) => void = () => {}

  constructor(handler: FakeHandler = () => ({})) {
    this.#handler = handler
  }

  onStderr(handler: (text: string) => void): void {
    this.#stderr = handler
  }

  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void {
    this.#notification = handler
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#serverRequest = handler
  }

  request(
    method: string,
    params?: JsonRpcInput,
    options?: JsonRpcRequestOptions,
  ): Promise<JsonRpcValue | undefined>
  request<Result>(
    method: string,
    params: JsonRpcInput,
    options: ParsedJsonRpcRequestOptions<Result>,
  ): Promise<Result>
  request<Result>(
    method: string,
    params: JsonRpcInput = {},
    options: JsonRpcRequestOptions | ParsedJsonRpcRequestOptions<Result> = {},
  ): Promise<JsonRpcValue | undefined | Result> {
    const parsedParams = params === undefined ? undefined : JsonRpcValueSchema.parse(params)
    const call: RecordedRpcCall = { method, params: parsedParams }
    if (options.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs
    this.calls.push(call)
    const response = Promise.resolve(this.#handler(method, parsedParams))
    return 'result' in options ? response.then((value) => options.result.parse(value)) : response
  }

  notify(_method: string, _params?: JsonRpcInput): void {}

  dispose(): void {
    this.disposals += 1
  }

  emitNotification(method: string, params: JsonRpcValue): void {
    this.#notification(method, params)
  }

  emitStderr(text: string): void {
    this.#stderr(text)
  }

  emitServerRequest(method: string, params: JsonRpcValue): Promise<JsonRpcValue> {
    return new Promise((resolve) => this.#serverRequest(method, params, resolve))
  }
}
