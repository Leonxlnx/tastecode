import type { WebSocket } from 'ws'
import type { ChannelName, DataOf } from '@harness/contracts'

/**
 * All outbound pushes go through one ordered path.
 *
 * `sequence` is monotonic per connection, so a client that sees a gap knows it
 * missed something and can resync instead of silently diverging — the failure
 * mode that is impossible to debug after the fact.
 */
export class PushBus {
  #sockets = new Map<WebSocket, number>()

  add(socket: WebSocket): void {
    this.#sockets.set(socket, 0)
  }

  remove(socket: WebSocket): void {
    this.#sockets.delete(socket)
  }

  /**
   * Push to one connection. A dead socket must never take the caller down —
   * one client resetting its TCP connection cannot be allowed to starve every
   * other connection of the rest of a broadcast.
   */
  send<C extends ChannelName>(socket: WebSocket, channel: C, data: DataOf<C>): void {
    if (socket.readyState !== socket.OPEN) return
    const sequence = (this.#sockets.get(socket) ?? 0) + 1
    this.#sockets.set(socket, sequence)
    try {
      socket.send(JSON.stringify({ channel, sequence, data }), (error) => {
        if (error) this.remove(socket)
      })
    } catch {
      this.remove(socket)
    }
  }

  /** Push to every connection. Each keeps its own sequence. */
  broadcast<C extends ChannelName>(channel: C, data: DataOf<C>): void {
    for (const socket of [...this.#sockets.keys()]) this.send(socket, channel, data)
  }
}
