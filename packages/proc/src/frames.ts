/** Large enough for image and tool payloads, but finite even without a delimiter. */
export const MAX_PROTOCOL_FRAME_BYTES = 16 * 1024 * 1024

export class ProtocolFrameError extends Error {
  constructor() {
    super('Provider protocol frame exceeds the size limit')
    this.name = 'ProtocolFrameError'
  }
}

/** Retains at most one bounded line, including when chunks contain many lines. */
export class LineBuffer {
  #tail = ''
  #bytes = 0

  constructor(readonly maxBytes = MAX_PROTOCOL_FRAME_BYTES) {}

  get bufferedBytes(): number {
    return this.#bytes
  }

  write(chunk: string, onLine: (line: string) => void): void {
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf('\n', start)
      const part = chunk.slice(start, end < 0 ? undefined : end)
      this.#bytes += Buffer.byteLength(part)
      if (this.#bytes > this.maxBytes) {
        this.clear()
        throw new ProtocolFrameError()
      }
      this.#tail += part
      if (end < 0) return
      const line = this.#tail
      this.clear()
      onLine(line)
      start = end + 1
    }
  }

  end(onLine: (line: string) => void): void {
    const line = this.#tail
    this.clear()
    if (line) onLine(line)
  }

  clear(): void {
    this.#tail = ''
    this.#bytes = 0
  }
}

/** Shared SSE framing, including split CRLF, multiline data and bounded tails. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  maxBytes = MAX_PROTOCOL_FRAME_BYTES,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const lines = new LineBuffer(maxBytes)
  let frameBytes = 0
  let data: string[] = []
  let ready: string[] = []
  const line = (raw: string) => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!value) {
      if (data.length) ready.push(data.join('\n'))
      data = []
      frameBytes = 0
      return
    }
    frameBytes += Buffer.byteLength(raw) + 1
    if (frameBytes > maxBytes) throw new ProtocolFrameError()
    if (value.startsWith('data:')) data.push(value.slice(5).trimStart())
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      // A single upstream chunk can contain arbitrarily many frames. Feed it
      // in small parts so the ready queue also has a fixed memory bound.
      const chunk = decoder.decode(value, { stream: !done })
      for (let start = 0; start < chunk.length;) {
        let end = Math.min(start + 64 * 1024, chunk.length)
        const last = chunk.charCodeAt(end - 1)
        if (last >= 0xd800 && last <= 0xdbff && end < chunk.length) end++
        lines.write(chunk.slice(start, end), line)
        start = end
        if (frameBytes + lines.bufferedBytes > maxBytes) throw new ProtocolFrameError()
        for (const event of ready) yield event
        ready = []
      }
      if (done) {
        lines.end(line)
        line('')
        for (const event of ready) yield event
        return
      }
    }
  } finally {
    lines.clear()
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
