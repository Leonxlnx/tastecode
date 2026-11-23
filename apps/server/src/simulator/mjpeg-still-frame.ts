import { Transform, type TransformCallback } from 'node:stream'

const STILL_FRAME_DELAY_MS = 100
const HEADER_END = Buffer.from('\r\n\r\n')
const MAX_HEADER_BYTES = 16 * 1024
const MAX_PART_BYTES = 16 * 1024 * 1024

function parsePartLength(headers: string): number | undefined {
  if (!headers.startsWith('--')) return undefined
  const match = /^content-length:\s*(\d+)\s*$/im.exec(headers)
  if (!match) return undefined
  const length = Number(match[1])
  return Number.isFinite(length) && length <= MAX_PART_BYTES ? length : undefined
}

function endsWithCrlf(parts: readonly Buffer[]): boolean {
  const last = parts.at(-1)
  if (!last || last.length === 0) return false
  const lf = last[last.length - 1]
  const cr = last.length > 1 ? last[last.length - 2] : parts.at(-2)?.at(-1)
  return cr === 0x0d && lf === 0x0a
}

/**
 * Browsers paint a multipart/x-mixed-replace part only once the next part
 * begins, and `serve-sim` writes a part only when the simulator screen changes.
 * Re-sending the last complete part once after a brief quiet period makes a
 * static simulator screen paint immediately in `<img>`.
 */
export class MjpegStillFrameTransform extends Transform {
  #pieces: Buffer[] = []
  #size = 0
  #partEnd: number | null = null
  #tracking = true
  #still: Buffer[] | null = null
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly delayMs = STILL_FRAME_DELAY_MS) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#clearTimer()
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.#feed(buf)
    this.push(buf)
    if (this.#still) {
      const pending = this.#still
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        if (this.#still !== pending || this.destroyed) return
        this.#still = null
        for (const piece of pending) this.push(piece)
      }, this.delayMs)
      this.#timer.unref()
    }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    this.#clearTimer()
    this.#still = null
    this.#pieces = []
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#clearTimer()
    this.#still = null
    this.#pieces = []
    callback(error)
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #feed(chunk: Buffer): void {
    if (!this.#tracking) return
    let rest = chunk
    let completed: Buffer[] | undefined
    while (rest.length > 0) {
      if (this.#partEnd === null) {
        const head =
          this.#size === 0
            ? rest
            : Buffer.concat([
                ...this.#pieces,
                rest.subarray(0, MAX_HEADER_BYTES + HEADER_END.length),
              ])
        const headerEnd = head.indexOf(HEADER_END)
        if (headerEnd < 0 && head.length <= MAX_HEADER_BYTES) {
          this.#pieces.push(rest)
          this.#size += rest.length
          break
        }
        const length =
          headerEnd < 0 || headerEnd > MAX_HEADER_BYTES
            ? undefined
            : parsePartLength(head.subarray(0, headerEnd).toString('latin1'))
        if (length === undefined) {
          this.#tracking = false
          break
        }
        this.#partEnd = headerEnd + HEADER_END.length + length + 2
      }
      const taken = rest.subarray(0, this.#partEnd - this.#size)
      this.#pieces.push(taken)
      this.#size += taken.length
      rest = rest.subarray(taken.length)
      if (this.#size < this.#partEnd) break
      const candidate = this.#pieces
      if (candidate.length === 0 || !endsWithCrlf(candidate)) {
        this.#tracking = false
        break
      }
      completed = candidate
      this.#pieces = []
      this.#size = 0
      this.#partEnd = null
    }
    if (!this.#tracking) this.#pieces = []
    this.#still = this.#tracking && this.#size === 0 ? (completed ?? this.#still) : null
  }
}
