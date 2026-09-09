import type { WebSocket } from 'ws'
import type { ChannelName, DataOf } from '@harness/contracts'

export type PushSocket = Pick<WebSocket, 'OPEN' | 'readyState' | 'send' | 'terminate'> &
  Partial<Pick<WebSocket, 'bufferedAmount'>>
export const MAX_PUSH_BUFFER_BYTES = 8 * 1024 * 1024
export const MAX_REPLY_FRAME_BYTES = 128 * 1024 * 1024
type PushSocketState = { sequence: number; onSend: (error?: Error) => void }
type RecordedEventChannel = 'thread.event' | 'sideChat.event'

const framePrefixes: Partial<Record<ChannelName, string>> = Object.create(null) as Partial<
  Record<ChannelName, string>
>

function framePrefix(channel: ChannelName): string {
  let prefix = framePrefixes[channel]
  if (prefix === undefined) {
    prefix = `{"channel":${JSON.stringify(channel)},"sequence":`
    framePrefixes[channel] = prefix
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
  #onlySocket: Socket | undefined
  #onlySocketState: PushSocketState | undefined
  #lastRecordedThreadId: string | undefined
  #lastRecordedThreadIdJson = ''

  add(socket: Socket): void {
    if (this.#sockets.has(socket)) return
    const state: PushSocketState = {
      sequence: 0,
      onSend: (error) => {
        if (error) {
          this.remove(socket)
          socket.terminate()
        }
      },
    }
    this.#sockets.set(socket, state)
    if (this.#sockets.size === 1) {
      this.#onlySocket = socket
      this.#onlySocketState = state
    } else {
      this.#onlySocket = undefined
      this.#onlySocketState = undefined
    }
  }

  remove(socket: Socket): void {
    if (!this.#sockets.delete(socket)) return
    const only = this.#sockets.size === 1 ? this.#sockets.entries().next().value : undefined
    this.#onlySocket = only?.[0]
    this.#onlySocketState = only?.[1]
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

  /** RPC results share the output budget without consuming push sequence numbers. */
  reply(socket: Socket, frame: string): void {
    const state = this.#sockets.get(socket)
    if (socket.readyState === socket.OPEN && state)
      this.#sendFrame(socket, state, frame, MAX_REPLY_FRAME_BYTES)
  }

  #sendSerialized(socket: Socket, prefix: string, dataJson: string): void {
    if (socket.readyState !== socket.OPEN) return
    // Never re-register a socket we have already dropped: restarting its
    // counter at 1 would send sequence numbers backwards mid-connection.
    const state = this.#sockets.get(socket)
    if (state === undefined) return
    const sequence = ++state.sequence
    this.#sendFrame(socket, state, `${prefix}${sequence},"data":${dataJson}}`)
  }

  #sendFrame(
    socket: Socket,
    state: PushSocketState,
    frame: string,
    frameLimit = MAX_PUSH_BUFFER_BYTES,
  ): void {
    // A failed write closes the connection rather than quietly unsubscribing
    // it. Dropping it from the map left the socket OPEN and silent: the
    // client's onclose never fired, its gap detector only fires on a frame it
    // does receive, and the thread simply froze with no warning.
    try {
      const queued = socket.bufferedAmount ?? 0
      if (queued >= MAX_PUSH_BUFFER_BYTES || queued + Buffer.byteLength(frame) > frameLimit) {
        this.remove(socket)
        socket.terminate()
        return
      }
      socket.send(frame, state.onSend)
    } catch {
      this.remove(socket)
      socket.terminate()
    }
  }

  /** Push to every connection. Each keeps its own sequence. */
  broadcast<C extends ChannelName>(channel: C, data: DataOf<C>): void {
    const onlySocket = this.#onlySocket
    const onlyState = this.#onlySocketState
    if (onlySocket !== undefined && onlyState !== undefined) {
      // The desktop normally owns one renderer. Use the retained Map entry
      // directly so that hot pushes do not allocate a Map iterator.
      if (onlySocket.readyState !== onlySocket.OPEN) return
      const sequence = ++onlyState.sequence
      const frame = `${framePrefix(channel)}${sequence},"data":${JSON.stringify(data)}}`
      this.#sendFrame(onlySocket, onlyState, frame)
      return
    }
    if (this.#sockets.size === 0) return

    const prefix = framePrefix(channel)
    const dataJson = JSON.stringify(data)
    let previousSequence = -1
    let previousFrame = ''
    for (const [socket, state] of this.#sockets) {
      if (socket.readyState !== socket.OPEN) continue
      const sequence = ++state.sequence
      if (sequence !== previousSequence) {
        previousSequence = sequence
        previousFrame = `${prefix}${sequence},"data":${dataJson}}`
      }
      this.#sendFrame(socket, state, previousFrame)
    }
  }

  /** Reuse the exact event JSON already written to SQLite. */
  broadcastRecordedEvent(
    channel: RecordedEventChannel,
    threadId: string,
    serializedEvent: string,
    seq: number,
  ): void {
    const onlySocket = this.#onlySocket
    const onlyState = this.#onlySocketState
    if (onlySocket !== undefined && onlyState !== undefined) {
      // Recorded deltas are the hottest push. Keep their common one-renderer
      // path direct while the fan-out path below still reuses whole frames.
      if (onlySocket.readyState !== onlySocket.OPEN) return
    } else if (this.#sockets.size === 0) return

    let threadIdJson = this.#lastRecordedThreadIdJson
    if (threadId !== this.#lastRecordedThreadId) {
      this.#lastRecordedThreadId = threadId
      threadIdJson = JSON.stringify(threadId)
      this.#lastRecordedThreadIdJson = threadIdJson
    }

    if (onlySocket !== undefined && onlyState !== undefined) {
      const sequence = ++onlyState.sequence
      const frame = `${framePrefix(channel)}${sequence},"data":{"threadId":${threadIdJson},"event":${serializedEvent},"seq":${seq}}}`
      this.#sendFrame(onlySocket, onlyState, frame)
      return
    }

    const prefix = framePrefix(channel)
    const dataJson = `{"threadId":${threadIdJson},"event":${serializedEvent},"seq":${seq}}`
    let previousSequence = -1
    let previousFrame = ''
    for (const [socket, state] of this.#sockets) {
      if (socket.readyState !== socket.OPEN) continue
      const sequence = ++state.sequence
      if (sequence !== previousSequence) {
        previousSequence = sequence
        previousFrame = `${prefix}${sequence},"data":${dataJson}}`
      }
      this.#sendFrame(socket, state, previousFrame)
    }
  }
}
