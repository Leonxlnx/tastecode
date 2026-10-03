import type { ConnectionState, Transport } from '../transport.js'

const owners = new WeakMap<Transport, TerminalOwnership>()
const RETRY_DELAYS = [250, 1_000, 4_000] as const

type PendingClose = {
  key: string
  inFlight: boolean
  retries: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Keep close intent outside the pane without queueing expiring offline requests. */
class TerminalOwnership {
  readonly leases = new Map<string, number>()
  readonly pending = new Map<string, PendingClose>()
  offState: (() => void) | undefined

  constructor(readonly transport: Transport) {}

  acquire(key: string) {
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)
    for (const [id, close] of this.pending) {
      if (close.key === key) this.forget(id, close)
    }
    return {
      release: () => {
        const next = (this.leases.get(key) ?? 1) - 1
        if (next > 0) this.leases.set(key, next)
        else this.leases.delete(key)
      },
      closeWhenUnleased: (id: string) => this.close(key, id),
    }
  }

  close(key: string, id: string): void {
    if (this.leases.has(key) || this.pending.has(id) || this.transport.state === 'closed') return
    const close: PendingClose = { key, inFlight: false, retries: 0, timer: undefined }
    this.pending.set(id, close)
    this.offState ??= this.transport.onState((state) => this.onState(state))
    this.send(id, close)
  }

  onState(state: ConnectionState): void {
    for (const [id, close] of this.pending) {
      clearTimeout(close.timer)
      close.timer = undefined
      if (state === 'closed') this.forget(id, close)
      else if (state === 'open') {
        close.retries = 0
        this.send(id, close)
      }
    }
  }

  send(id: string, close: PendingClose): void {
    if (this.pending.get(id) !== close || close.inFlight || close.timer !== undefined) return
    if (this.leases.has(close.key) || this.transport.state === 'closed') {
      this.forget(id, close)
      return
    }
    if (this.transport.state !== 'open') return
    close.inFlight = true
    void this.transport.request('terminal.close', { terminalId: id }).then(
      () => this.forget(id, close),
      (error: unknown) => {
        close.inFlight = false
        if (this.pending.get(id) !== close) return
        if (this.leases.has(close.key) || this.transport.state === 'closed') {
          this.forget(id, close)
          return
        }
        if (this.transport.state !== 'open') return
        const delay = RETRY_DELAYS[close.retries++]
        if (delay === undefined) {
          // Keep the intent for the next connection, but never poll forever.
          console.warn('[terminal] close failed; will retry after reconnect', error)
          return
        }
        close.timer = setTimeout(() => {
          close.timer = undefined
          this.send(id, close)
        }, delay)
      },
    )
  }

  forget(id: string, close: PendingClose): void {
    if (this.pending.get(id) !== close) return
    clearTimeout(close.timer)
    this.pending.delete(id)
    if (this.pending.size === 0) {
      this.offState?.()
      this.offState = undefined
    }
  }
}

export function acquireTerminalLease(transport: Transport, key: string) {
  let owner = owners.get(transport)
  if (!owner) {
    owner = new TerminalOwnership(transport)
    owners.set(transport, owner)
  }
  return owner.acquire(key)
}
