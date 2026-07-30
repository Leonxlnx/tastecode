import type { ChildProcessWithoutNullStreams } from 'node:child_process'

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

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type ServerRequestHandler = (
  method: string,
  params: unknown,
  respond: (result: unknown) => void,
) => void

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
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
  #label: string

  #onNotification: (method: string, params: unknown) => void = () => {}
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
    child.on('exit', (code) => this.#failAll(new Error(`${this.#label} exited (code ${code})`)))
    child.on('error', (error) => this.#failAll(error))
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#onNotification = handler
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#onServerRequest = handler
  }

  onStderr(handler: (text: string) => void): void {
    this.#onStderr = handler
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error('transport disposed'))
    const id = this.#nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.#write({ jsonrpc: '2.0', id, method, params })
    return promise as Promise<T>
  }

  notify(method: string, params: unknown = {}): void {
    if (this.#disposed) return
    this.#write({ jsonrpc: '2.0', method, params })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#failAll(new Error('transport disposed'))
    this.#child.kill()
  }

  #write(message: unknown): void {
    this.#child.stdin.write(JSON.stringify(message) + '\n')
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
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A non-JSON line means the CLI printed something to stdout that is not
      // protocol traffic. Surfacing it beats silently discarding it, because
      // that is usually a real error message.
      this.#onStderr(`non-JSON on stdout: ${line}`)
      return
    }

    const id = message['id'] as JsonRpcId | undefined
    const method = message['method'] as string | undefined

    if (id !== undefined && method === undefined) {
      this.#settle(id, message)
      return
    }

    if (id !== undefined && method !== undefined) {
      // A request from the agent — approvals and file access arrive this way.
      this.#onServerRequest(method, message['params'], (result) => {
        this.#write({ jsonrpc: '2.0', id, result })
      })
      return
    }

    if (method !== undefined) {
      this.#onNotification(method, message['params'])
    }
  }

  #settle(id: JsonRpcId, message: Record<string, unknown>): void {
    const call = this.#pending.get(id)
    if (!call) return
    this.#pending.delete(id)

    const error = message['error'] as
      { code?: number; message?: string; data?: unknown } | undefined
    if (error) {
      call.reject(new JsonRpcError(error.code ?? 0, error.message ?? 'unknown error', error.data))
      return
    }
    call.resolve(message['result'])
  }

  #failAll(error: Error): void {
    for (const [, call] of this.#pending) call.reject(error)
    this.#pending.clear()
  }
}
