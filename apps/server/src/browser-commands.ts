import { randomUUID } from 'node:crypto'
import { BrowserCommandSchema, type BrowserCommand, type BrowserResult } from '@harness/contracts'
import type { WebSocket } from 'ws'

/** A command as an agent tool asks for it; the coordinator adds the chat and its own id. */
export type BrowserRequest = BrowserCommand extends infer Command
  ? Command extends BrowserCommand
    ? Omit<Command, 'threadId' | 'commandId'>
    : never
  : never

/** What a successful command answered. */
export type BrowserAnswer = Extract<BrowserResult, { ok: true }>

/** The command could not run, for a reason the agent should read: no window, a refusal, time. */
export class BrowserCommandError extends Error {}

type Pending<Client> = {
  socket: Client
  threadId: string
  resolve: (answer: BrowserAnswer) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Runs agent browser commands on the in-app browser tab of the chat they belong to. Only a client
 * that declared browserTools and lists that chat as shown gets one; with none, the command fails
 * at once instead of waiting out its time.
 */
export class BrowserCommandCoordinator<Client extends object = WebSocket> {
  #clients = new Map<Client, ReadonlySet<string>>()
  #pending = new Map<string, Pending<Client>>()

  constructor(
    private readonly send: (socket: Client, command: BrowserCommand) => void,
    private readonly cancel: (socket: Client, commandId: string) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  setCapability(
    socket: Client,
    browserTools: boolean | undefined,
    threads: readonly string[] = [],
  ) {
    if (!browserTools) {
      this.remove(socket)
      return
    }
    const shown = new Set(threads)
    this.#clients.set(socket, shown)
    // A chat the window stopped showing takes its browser tab with it.
    for (const [commandId, pending] of this.#pending) {
      if (pending.socket === socket && !shown.has(pending.threadId))
        this.#end(commandId, new BrowserCommandError('The chat is no longer shown in TasteCode.'))
    }
  }

  remove(socket: Client): void {
    this.#clients.delete(socket)
    for (const [commandId, pending] of this.#pending) {
      if (pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.#pending.delete(commandId)
      pending.reject(new BrowserCommandError('The TasteCode window showing the chat closed.'))
    }
  }

  run(threadId: string, request: BrowserRequest, signal?: AbortSignal): Promise<BrowserAnswer> {
    if (signal?.aborted) return Promise.reject(new BrowserCommandError('The call was cancelled.'))
    const socket = [...this.#clients].find(([, shown]) => shown.has(threadId))?.[0]
    if (!socket) {
      return Promise.reject(
        new BrowserCommandError(
          'No TasteCode window shows this chat, so its browser is unavailable. Continue without it.',
        ),
      )
    }
    // The contract checks every field again: an http(s) page, one shape per action, the caps.
    const command = BrowserCommandSchema.parse({ ...request, threadId, commandId: randomUUID() })
    return new Promise<BrowserAnswer>((resolve, reject) => {
      const onAbort = () =>
        this.#end(command.commandId, new BrowserCommandError('The call was cancelled.'))
      const timer = setTimeout(
        () =>
          this.#end(
            command.commandId,
            new BrowserCommandError(
              `The browser did not answer within ${Math.round(this.timeoutMs / 1000)} s.`,
            ),
          ),
        this.timeoutMs,
      )
      this.#pending.set(command.commandId, {
        socket,
        threadId,
        resolve: (answer) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(answer)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.send(socket, command)
      } catch {
        this.remove(socket)
      }
    })
  }

  complete(socket: Client, result: BrowserResult): void {
    const pending = this.#pending.get(result.commandId)
    if (!pending || pending.socket !== socket) throw new Error('Unknown browser command')
    clearTimeout(pending.timer)
    this.#pending.delete(result.commandId)
    if (result.ok) pending.resolve(result)
    else pending.reject(new BrowserCommandError(result.error))
  }

  /** The chat's turn stopped: its commands end, and the window clears its browser bar. */
  cancelThread(threadId: string): void {
    for (const [commandId, pending] of this.#pending) {
      if (pending.threadId === threadId)
        this.#end(commandId, new BrowserCommandError('The turn stopped.'))
    }
  }

  #end(commandId: string, error: Error): void {
    const pending = this.#pending.get(commandId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(commandId)
    try {
      this.cancel(pending.socket, commandId)
    } catch {
      // A window that cannot hear the cancel is closing; its remove() follows.
    }
    pending.reject(error)
  }
}
