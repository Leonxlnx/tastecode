import type { WebSocket } from 'ws'
import type { ChannelName, DataOf } from '@harness/contracts'

export type PushSocket = Pick<WebSocket, 'OPEN' | 'readyState' | 'send' | 'terminate'>

/**
 * All outbound pushes go through one ordered path.
 *
 * `sequence` is monotonic per connection, so a client that sees a gap knows it
 * missed something and can resync instead of silently diverging — the failure
 * mode that is impossible to debug after the fact.
 */
export class PushBus<Socket extends PushSocket = WebSocket> {
  #sockets = new Map<Socket, number>()

  add(socket: Socket): void {
    this.#sockets.set(socket, 0)
  }

  remove(socket: Socket): void {
    this.#sockets.delete(socket)
  }

  /**
   * Push to one connection. A dead socket must never take the caller down —
   * one client resetting its TCP connection cannot be allowed to starve every
   * other connection of the rest of a broadcast.
   */
  send<C extends ChannelName>(socket: Socket, channel: C, data: DataOf<C>): void {
    if (socket.readyState !== socket.OPEN) return
    // Never re-register a socket we have already dropped: restarting its
    // counter at 1 would send sequence numbers backwards mid-connection.
    const previous = this.#sockets.get(socket)
    if (previous === undefined) return
    const sequence = previous + 1
    this.#sockets.set(socket, sequence)
    // A failed write closes the connection rather than quietly unsubscribing
    // it. Dropping it from the map left the socket OPEN and silent: the
    // client's onclose never fired, its gap detector only fires on a frame it
    // does receive, and the thread simply froze with no warning.
    try {
      socket.send(JSON.stringify({ channel, sequence, data }), (error) => {
        if (error) socket.terminate()
      })
    } catch {
      socket.terminate()
    }
  }

  /** Push to every connection. Each keeps its own sequence. */
  broadcast<C extends ChannelName>(channel: C, data: DataOf<C>): void {
    for (const socket of this.#sockets.keys()) this.send(socket, channel, data)
  }
}
