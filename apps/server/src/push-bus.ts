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

  /** Push to one connection. */
  send<C extends ChannelName>(socket: WebSocket, channel: C, data: DataOf<C>): void {
    const sequence = (this.#sockets.get(socket) ?? 0) + 1
    this.#sockets.set(socket, sequence)
    socket.send(JSON.stringify({ channel, sequence, data }))
  }

  /** Push to every connection. Each keeps its own sequence. */
  broadcast<C extends ChannelName>(channel: C, data: DataOf<C>): void {
    for (const socket of this.#sockets.keys()) this.send(socket, channel, data)
  }
}
