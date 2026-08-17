import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'
import { killTree } from './kill.js'

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 *
 * Bidirectional on purpose: agents initiate requests too — Codex asks for
 * command approval, ACP agents ask for permission and for file reads — so this
 * is a peer, not a client.
 *
 * Shared because both protocols framed themselves the same way. The parts that
 * differ between them are method names and payloads, which belong in adapters,
 * not here.
 */

export type JsonRpcId = number | string

export const JsonRpcValueSchema = z.json()
const JsonRpcInputSchema = z.unknown()
const JsonRpcFrameSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: JsonRpcValueSchema.optional(),
  result: JsonRpcValueSchema.optional(),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
      data: JsonRpcValueSchema.optional(),
    })
    .optional(),
})

export type JsonRpcValue = z.infer<typeof JsonRpcValueSchema>
export type JsonRpcInput = z.input<typeof JsonRpcInputSchema>
type JsonRpcResult = JsonRpcValue | undefined

export interface JsonRpcResultParser<Result> {
  parse(value: JsonRpcInput): Result
}

export interface JsonRpcRequestOptions {
  timeoutMs?: number
}

export interface ParsedJsonRpcRequestOptions<Result> extends JsonRpcRequestOptions {
  result: JsonRpcResultParser<Result>
}

type PendingCall = {
  resolve: (value: JsonRpcResult) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export type ServerRequestHandler = (
  method: string,
  params: JsonRpcResult,
  respond: (result: JsonRpcValue) => void,
) => void

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonRpcValue,
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }
}

export class StdioJsonRpc {
  #child: ChildProcessWithoutNullStreams
  /**
   * Our outbound calls only.
   *
   * The peer numbers its own requests independently and starts at 0, so ids
   * collide across directions. They are never confused because an incoming
   * frame carrying `method` is a request to us, and one without is a reply to
   * us — the id alone is not enough to tell them apart.
   */
  #pending = new Map<JsonRpcId, PendingCall>()
  #nextId = 1
  #buffer = ''
  #disposed = false
  #exited = false
  /** Why the transport is finished, so late callers get an answer not a hang. */
  #failure: Error | undefined
  #label: string

  #onNotification: (method: string, params: JsonRpcResult) => void = () => {}
  #onServerRequest: ServerRequestHandler = (_m, _p, respond) => respond(null)
  #onStderr: (text: string) => void = () => {}

  /** `label` names the process in errors, so a dead child says which one died. */
  constructor(child: ChildProcessWithoutNullStreams, label = 'agent') {
    this.#child = child
    this.#label = label
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.#ingest(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.#onStderr(chunk))
    child.on('exit', (code) => {
      this.#exited = true
      this.#failure ??= new Error(`${this.#label} exited (code ${code})`)
      this.#failAll(this.#failure)
    })
    child.on('error', (error) => {
      this.#exited = true
      this.#failure ??= error
      this.#failAll(error)
    })
    // A write after the peer died raises EPIPE as a stream 'error' event;
    // without a listener that crashes the process instead of failing a call.
    child.stdin.on('error', (error) => this.#onStderr(`stdin: ${String(error)}`))
  }

  onNotification(handler: (method: string, params: JsonRpcResult) => void): void {
    this.#onNotification = handler
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#onServerRequest = handler
  }

  onStderr(handler: (text: string) => void): void {
    this.#onStderr = handler
  }

  request(
    method: string,
    params?: JsonRpcInput,
    options?: JsonRpcRequestOptions,
  ): Promise<JsonRpcResult>
  request<Result>(
    method: string,
    params: JsonRpcInput,
    options: ParsedJsonRpcRequestOptions<Result>,
  ): Promise<Result>
  request<Result>(
    method: string,
    params: JsonRpcInput = {},
    options: JsonRpcRequestOptions | ParsedJsonRpcRequestOptions<Result> = {},
  ): Promise<JsonRpcResult | Result> {
    // Also when the process is gone: #write silently drops the frame once the
    // child has exited, so a call made after a crash used to sit pending
    // forever — the session stayed at "Working" with no error and no way out.
    if (this.#failure) return Promise.reject(this.#failure)
    if (this.#disposed) return Promise.reject(new Error('transport disposed'))
    const id = this.#nextId++
    const promise = new Promise<JsonRpcResult>((resolve, reject) => {
      const call: PendingCall = { resolve, reject }
      if (options.timeoutMs !== undefined) {
        call.timer = setTimeout(() => {
          if (this.#pending.delete(id)) {
            reject(new Error(`${this.#label} request timed out: ${method}`))
          }
        }, options.timeoutMs)
      }
      this.#pending.set(id, call)
    })
    const message = { jsonrpc: '2.0', id, method, params: JsonRpcValueSchema.parse(params) }
    this.#write(message)
    return 'result' in options ? promise.then((value) => options.result.parse(value)) : promise
  }

  notify(method: string, params: JsonRpcInput = {}): void {
    if (this.#disposed) return
    this.#write({ jsonrpc: '2.0', method, params })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#failAll(new Error('transport disposed'))
    killTree(this.#child)
  }

  #write(message: JsonRpcInput): void {
    if (this.#exited || !this.#child.stdin.writable) return
    this.#child.stdin.write(JSON.stringify(JsonRpcValueSchema.parse(message)) + '\n')
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk
    let newline: number
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line) this.#handleLine(line)
    }
  }

  #handleLine(line: string): void {
    let parsed: JsonRpcInput
    try {
      parsed = JSON.parse(line)
    } catch {
      // A non-JSON line means the CLI printed something to stdout that is not
      // protocol traffic. Surfacing it beats silently discarding it, because
      // that is usually a real error message.
      this.#onStderr(`non-JSON on stdout: ${line}`)
      return
    }

    const frame = JsonRpcFrameSchema.safeParse(parsed)
    if (!frame.success) {
      this.#onStderr(`invalid JSON-RPC on stdout: ${line}`)
      return
    }
    const message = frame.data

    const { id, method } = message

    if (id !== undefined && method === undefined) {
      this.#settle(id, message)
      return
    }

    // Handlers cast frames to the shapes the protocol documents, so a frame
    // that is valid JSON but the wrong shape throws a TypeError — and this
    // runs inside a stdout listener, where an escaping throw would take down
    // the whole server, every session, over one agent's bad frame.
    try {
      if (id !== undefined && method !== undefined) {
        // A request from the agent — approvals and file access arrive this way.
        this.#onServerRequest(method, message.params, (result) => {
          this.#write({ jsonrpc: '2.0', id, result })
        })
        return
      }

      if (method !== undefined) {
        this.#onNotification(method, message.params)
      }
    } catch (error) {
      this.#onStderr(`handler failed for ${method ?? 'response'}: ${String(error)}`)
    }
  }

  #settle(id: JsonRpcId, message: z.infer<typeof JsonRpcFrameSchema>): void {
    const call = this.#pending.get(id)
    if (!call) return
    this.#pending.delete(id)
    clearTimeout(call.timer)

    const { error } = message
    if (error) {
      call.reject(new JsonRpcError(error.code ?? 0, error.message ?? 'unknown error', error.data))
      return
    }
    call.resolve(message.result)
  }

  #failAll(error: Error): void {
    for (const [, call] of this.#pending) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.#pending.clear()
  }
}
