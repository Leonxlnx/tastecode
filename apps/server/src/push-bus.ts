import type { WebSocket } from 'ws'
import type { ChannelName, DataOf } from '@harness/contracts'

export type PushSocket = Pick<WebSocket, 'OPEN' | 'readyState' | 'send' | 'terminate'>
type PushSocketState = { sequence: number; onSend: (error?: Error) => void }
type RecordedEventChannel = 'thread.event' | 'sideChat.event'

const framePrefixes = new Map<string, string>()

function framePrefix(channel: ChannelName): string {
  let prefix = framePrefixes.get(channel)
  if (prefix === undefined) {
    prefix = `{"channel":${JSON.stringify(channel)},"sequence":`
    framePrefixes.set(channel, prefix)
  }
  return prefix
}

/**
 * All outbound pushes go through one ordered path.
 *
 * `sequence` is monotonic per connection, so a client that sees a gap knows it
 * missed something and can resync instead of silently diverging — the failure
 * mode that is impossible to debug after the fact.
 */
export class PushBus<Socket extends PushSocket = WebSocket> {
  #sockets = new Map<Socket, PushSocketState>()

  add(socket: Socket): void {
    this.#sockets.set(socket, {
      sequence: 0,
      onSend: (error) => {
        if (error) socket.terminate()
      },
    })
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
    if (socket.readyState !== socket.OPEN || !this.#sockets.has(socket)) return
    const dataJson = JSON.stringify(data)
    this.#sendSerialized(socket, framePrefix(channel), dataJson)
  }

  #sendSerialized(socket: Socket, prefix: string, dataJson: string): void {
    if (socket.readyState !== socket.OPEN) return
    // Never re-register a socket we have already dropped: restarting its
    // counter at 1 would send sequence numbers backwards mid-connection.
    const state = this.#sockets.get(socket)
    if (state === undefined) return
    const sequence = ++state.sequence
    // A failed write closes the connection rather than quietly unsubscribing
    // it. Dropping it from the map left the socket OPEN and silent: the
    // client's onclose never fired, its gap detector only fires on a frame it
    // does receive, and the thread simply froze with no warning.
    try {
      socket.send(`${prefix}${sequence},"data":${dataJson}}`, state.onSend)
    } catch {
      socket.terminate()
    }
  }

  /** Push to every connection. Each keeps its own sequence. */
  broadcast<C extends ChannelName>(channel: C, data: DataOf<C>): void {
    let prefix: string | undefined
    let dataJson: string | undefined
    for (const socket of this.#sockets.keys()) {
      if (socket.readyState !== socket.OPEN) continue
      prefix ??= framePrefix(channel)
      dataJson ??= JSON.stringify(data)
      this.#sendSerialized(socket, prefix, dataJson)
    }
  }

  /** Reuse the exact event JSON already written to SQLite. */
  broadcastRecordedEvent(
    channel: RecordedEventChannel,
    threadId: string,
    serializedEvent: string,
    seq: number,
  ): void {
    let prefix: string | undefined
    let dataJson: string | undefined
    for (const socket of this.#sockets.keys()) {
      if (socket.readyState !== socket.OPEN) continue
      prefix ??= framePrefix(channel)
      dataJson ??= `{"threadId":${JSON.stringify(threadId)},"event":${serializedEvent},"seq":${seq}}`
      this.#sendSerialized(socket, prefix, dataJson)
    }
  }
}
