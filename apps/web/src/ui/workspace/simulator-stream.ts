import type {
  SimulatorHubAccess,
  SimulatorOrientation,
  SimulatorPlatform,
} from '@harness/contracts'
import { withHubTicket } from './simulator-hub-api.js'

export type SimulatorStreamStatus = 'connecting' | 'streaming' | 'error'

export type SimulatorScreenInfo = {
  readonly width: number
  readonly height: number
  readonly orientation: SimulatorOrientation
}

export type SimulatorHardwareButton = 'home' | 'back' | 'recents' | 'power' | 'appSwitcher'

export type SimulatorStreamEvents = {
  readonly onStatus: (status: SimulatorStreamStatus, detail?: string) => void
  readonly onScreen: (screen: SimulatorScreenInfo) => void
  readonly onUnauthorized: () => void
  readonly onMjpegFallback: (url: string) => void
  readonly onInputConnected: (connected: boolean, detail?: string) => void
}

export type SimulatorKeyInput = Pick<
  KeyboardEvent,
  'code' | 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'
>

export type IosKeyMessage = {
  readonly type: 'down' | 'up'
  readonly usage: number
  readonly key?: string
  readonly shifted?: true
}

export type SimulatorStreamClient = {
  readonly start: () => void
  readonly stop: () => void
  readonly setMjpegImage: (image: HTMLImageElement | null) => void
  readonly sendTouch: (phase: 'begin' | 'move' | 'end', x: number, y: number) => void
  readonly sendKey: (event: SimulatorKeyInput, phase: 'down' | 'up') => boolean
  readonly sendMetaChord: (code: string, shiftKey?: boolean) => boolean
  readonly sendText: (text: string) => void
  readonly pressButton: (button: SimulatorHardwareButton) => void
  readonly rotate: () => void
}

const RETRY_DELAY_MS = 1_000
const FIRST_FRAME_TIMEOUT_MS = 15_000
const MJPEG_FRAME_CHECK_MS = 250
const FRAME_DURATION_US = 16_667
const SEMU_MAGIC = 0x53454d55
const SEMU_HEADER_BYTES = 16
const SEMU_FLAG_KEY = 1
const SOFT_DECODE_QUEUE = 8
const ANDROID_MAX_TEXT_BYTES = 300
const ANDROID_MAX_TEXT_CHUNKS = 64

const IOS_MSG_TOUCH = 0x03
const IOS_MSG_BUTTON = 0x04
const IOS_MSG_KEY = 0x06
const IOS_MSG_ORIENTATION = 0x07
const IOS_MSG_PASTE = 0x12
const IOS_MAX_INPUT_FRAME_BYTES = 4 * 1024 * 1024
const IOS_TAG_SCREEN_CONFIG = 0x82
const IOS_TAG_INPUT_ADMITTED = 0x83
const HID_USAGE_SHIFT_LEFT = 0xe1
const HID_USAGE_META_LEFT = 0xe3

const IOS_ORIENTATIONS: readonly SimulatorOrientation[] = [
  'portrait',
  'landscape_left',
  'portrait_upside_down',
  'landscape_right',
]

const HID_USAGE_BY_CODE = new Map<string, number>([
  ['Enter', 0x28],
  ['Escape', 0x29],
  ['Backspace', 0x2a],
  ['Tab', 0x2b],
  ['Space', 0x2c],
  ['Minus', 0x2d],
  ['Equal', 0x2e],
  ['BracketLeft', 0x2f],
  ['BracketRight', 0x30],
  ['Backslash', 0x31],
  ['Semicolon', 0x33],
  ['Quote', 0x34],
  ['Backquote', 0x35],
  ['Comma', 0x36],
  ['Period', 0x37],
  ['Slash', 0x38],
  ['CapsLock', 0x39],
  ['F1', 0x3a],
  ['F2', 0x3b],
  ['F3', 0x3c],
  ['F4', 0x3d],
  ['F5', 0x3e],
  ['F6', 0x3f],
  ['F7', 0x40],
  ['F8', 0x41],
  ['F9', 0x42],
  ['F10', 0x43],
  ['F11', 0x44],
  ['F12', 0x45],
  ['PrintScreen', 0x46],
  ['ScrollLock', 0x47],
  ['Pause', 0x48],
  ['Insert', 0x49],
  ['Home', 0x4a],
  ['PageUp', 0x4b],
  ['Delete', 0x4c],
  ['End', 0x4d],
  ['PageDown', 0x4e],
  ['ArrowRight', 0x4f],
  ['ArrowLeft', 0x50],
  ['ArrowDown', 0x51],
  ['ArrowUp', 0x52],
  ['NumLock', 0x53],
  ['NumpadDivide', 0x54],
  ['NumpadMultiply', 0x55],
  ['NumpadSubtract', 0x56],
  ['NumpadAdd', 0x57],
  ['NumpadEnter', 0x58],
  ['Numpad1', 0x59],
  ['Numpad2', 0x5a],
  ['Numpad3', 0x5b],
  ['Numpad4', 0x5c],
  ['Numpad5', 0x5d],
  ['Numpad6', 0x5e],
  ['Numpad7', 0x5f],
  ['Numpad8', 0x60],
  ['Numpad9', 0x61],
  ['Numpad0', 0x62],
  ['NumpadDecimal', 0x63],
  ['IntlBackslash', 0x64],
  ['NumpadEqual', 0x67],
  ['ControlLeft', 0xe0],
  ['ShiftLeft', 0xe1],
  ['AltLeft', 0xe2],
  ['MetaLeft', 0xe3],
  ['ControlRight', 0xe4],
  ['ShiftRight', 0xe5],
  ['AltRight', 0xe6],
  ['MetaRight', 0xe7],
])

const ANDROID_KEYCODE_BY_KEY = new Map<string, number>([
  ['ArrowUp', 19],
  ['ArrowDown', 20],
  ['ArrowLeft', 21],
  ['ArrowRight', 22],
  ['Tab', 61],
  ['Enter', 66],
  ['Backspace', 67],
  ['Delete', 112],
  ['Home', 122],
  ['End', 123],
  ['PageUp', 92],
  ['PageDown', 93],
])

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65)
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49)
  if (code === 'Digit0') return 0x27
  return HID_USAGE_BY_CODE.get(code) ?? null
}

/**
 * Encodes a keyboard event for `serve-sim` (`IOS_MSG_KEY`). Including `key` and
 * `shifted` lets `serve-sim` deliver uppercase letters, shifted symbols, and
 * non-US keyboard layout characters cleanly when the simulator's hardware
 * keyboard is off, while still using raw HID `usage` when it is on.
 */
export function iosKeyMessageForEvent(
  event: SimulatorKeyInput,
  phase: 'down' | 'up',
): IosKeyMessage | null {
  const usage = hidUsageForCode(event.code)
  if (usage === null) return null
  const includeKey = phase === 'down' && !event.metaKey && !event.ctrlKey && event.key.length === 1
  const shifted = includeKey && event.shiftKey && event.key !== ' '
  return {
    type: phase,
    usage,
    ...(includeKey ? { key: event.key } : {}),
    ...(shifted ? { shifted: true } : {}),
  }
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(payload))
  const out = new Uint8Array(1 + json.length)
  out[0] = tag
  out.set(json, 1)
  return out
}

function isWebCodecsSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    'VideoDecoder' in globalThis &&
    'EncodedVideoChunk' in globalThis
  )
}

export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return 'avc1.42E01E'
  const hex = (byte: number) => byte.toString(16).padStart(2, '0')
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`
}

export type ParsedSemuPacket = {
  readonly data: Uint8Array
  readonly isKey: boolean | null
  readonly timestamp: number | null
}

export function parseSemuPacket(raw: ArrayBuffer): ParsedSemuPacket {
  const bytes = new Uint8Array(raw)
  if (bytes.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(raw, 0, SEMU_HEADER_BYTES)
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false)
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      }
    }
  }
  return { data: bytes, isKey: null, timestamp: null }
}

export type AccessUnitScan = {
  readonly isKey: boolean
  readonly sps: Uint8Array | null
}

export function scanAccessUnit(buf: Uint8Array): AccessUnitScan {
  let isKey = false
  let sps: Uint8Array | null = null
  const len = buf.length
  let i = 0
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0
      if (buf[i + 2] === 1) codeLen = 3
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4
      if (codeLen) {
        const nalType = buf[i + codeLen]! & 0x1f
        if (nalType === 7 && !sps) sps = buf.subarray(i + codeLen)
        if (nalType === 5) isKey = true
        i += codeLen + 1
        continue
      }
    }
    i++
  }
  return { isKey, sps }
}

export type AvccChunk = {
  readonly type: 'description' | 'keyframe' | 'delta' | 'seed'
  readonly payload: Uint8Array
}

const AVCC_TAGS = new Map<number, AvccChunk['type']>([
  [1, 'description'],
  [2, 'keyframe'],
  [3, 'delta'],
  [4, 'seed'],
])

export class AvccDemuxer {
  #buffer = new Uint8Array(64 * 1024)
  #length = 0

  push(bytes: Uint8Array): AvccChunk[] {
    if (this.#length + bytes.length > this.#buffer.length) {
      let capacity = this.#buffer.length
      while (capacity < this.#length + bytes.length) capacity *= 2
      const grown = new Uint8Array(capacity)
      grown.set(this.#buffer.subarray(0, this.#length))
      this.#buffer = grown
    }
    this.#buffer.set(bytes, this.#length)
    this.#length += bytes.length

    const chunks: AvccChunk[] = []
    let offset = 0
    while (this.#length - offset >= 4) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, 4)
      const frameLength = view.getUint32(0, false)
      if (this.#length - offset - 4 < frameLength) break
      if (frameLength >= 1) {
        const type = AVCC_TAGS.get(this.#buffer[offset + 4]!)
        if (type) {
          chunks.push({ type, payload: this.#buffer.slice(offset + 5, offset + 4 + frameLength) })
        }
      }
      offset += 4 + frameLength
    }
    if (offset > 0) {
      this.#buffer.copyWithin(0, offset, this.#length)
      this.#length -= offset
    }
    return chunks
  }
}

function parseIosScreenConfig(value: unknown): {
  screen: SimulatorScreenInfo
  inputUnavailable: boolean
} | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const width = record['width']
  const height = record['height']
  const orientation = record['orientation']
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null
  }
  const validOrientation: SimulatorOrientation =
    orientation === 'portrait' ||
    orientation === 'portrait_upside_down' ||
    orientation === 'landscape_left' ||
    orientation === 'landscape_right'
      ? orientation
      : 'portrait'
  return {
    screen: { width, height, orientation: validOrientation },
    inputUnavailable: record['inputUnavailable'] === true,
  }
}

export function createSimulatorStreamClient(
  target: {
    readonly platform: SimulatorPlatform
    readonly deviceId: string
    readonly access: SimulatorHubAccess
  },
  canvas: HTMLCanvasElement,
  events: SimulatorStreamEvents,
): SimulatorStreamClient {
  const { platform, deviceId, access } = target
  const vendor = platform === 'ios' ? '/vendor/serve-sim' : '/vendor/serve-emu'
  const encodedDevice = encodeURIComponent(deviceId)
  const httpUrl = (route: string) =>
    withHubTicket(`${access.httpBase}${vendor}${route}`, access.ticket)
  const wsUrl = (route: string) => withHubTicket(`${access.wsBase}${vendor}${route}`, access.ticket)
  const useWebCodecs = isWebCodecsSupported()

  let stopped = true
  let generation = 0
  let videoGeneration = 0
  let decoderEpoch = 0
  let decodedVideoGeneration: number | null = null
  let socket: WebSocket | null = null
  let controller: AbortController | null = null
  let primeController: AbortController | null = null
  let videoDecoder: VideoDecoder | null = null
  let iosInputAdmitted = false
  let iosInputUnavailable = false
  let pasteRequestId = 0
  let timestamp = 0
  let awaitingKeyframe = true
  let configuring = false
  let firstFrame = false
  let mjpeg = false
  let screen: SimulatorScreenInfo | null = null
  let frameTimer: ReturnType<typeof setTimeout> | null = null
  let videoReadTimer: ReturnType<typeof setTimeout> | null = null
  let mjpegImage: HTMLImageElement | null = null
  let releaseImage: (() => void) | null = null
  const retryTimers = new Map<'video' | 'input', ReturnType<typeof setTimeout>>()

  const mjpegUrl = () => httpUrl(`/helper/${encodedDevice}/stream.mjpeg`)

  const setStatus = (status: SimulatorStreamStatus, detail?: string) => {
    if (!stopped) events.onStatus(status, detail)
  }

  const clearFrameTimer = () => {
    if (frameTimer !== null) {
      clearTimeout(frameTimer)
      frameTimer = null
    }
  }

  const fail = (detail: string) => {
    if (stopped) return
    stop()
    events.onInputConnected(false, detail)
    events.onStatus('error', detail)
  }

  const connecting = (detail?: string) => {
    firstFrame = false
    if (frameTimer === null) {
      frameTimer = setTimeout(
        () => fail('No video received from the simulator. Reconnect to try again.'),
        FIRST_FRAME_TIMEOUT_MS,
      )
    }
    setStatus('connecting', detail)
  }

  const frameReceived = () => {
    if (firstFrame) return
    firstFrame = true
    clearFrameTimer()
    setStatus('streaming')
  }

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return
    if (
      (platform === 'android' && (screen?.width !== width || screen?.height !== height)) ||
      (platform === 'ios' && !screen && width > 0 && height > 0)
    ) {
      screen = { width, height, orientation: width > height ? 'landscape_left' : 'portrait' }
      events.onScreen(screen)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      fail('Could not display the simulator video canvas.')
      return
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    ctx.drawImage(source, 0, 0, width, height)
    frameReceived()
  }

  const closeDecoder = () => {
    decoderEpoch++
    try {
      videoDecoder?.close()
    } catch {
      // Already closed.
    }
    videoDecoder = null
    awaitingKeyframe = true
  }

  const observeMjpegImage = () => {
    releaseImage?.()
    releaseImage = null
    const image = mjpegImage
    if (!image || stopped || !mjpeg) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let released = false
    const check = () => {
      if (released || stopped) return
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (image.naturalWidth > 0 && image.naturalHeight > 0) frameReceived()
      else timer = setTimeout(check, MJPEG_FRAME_CHECK_MS)
    }
    const onError = () => {
      if (released) return
      fail('Could not receive the simulator stream. Reconnect to try again.')
    }
    image.addEventListener('load', check)
    image.addEventListener('error', onError)
    releaseImage = () => {
      released = true
      if (timer !== null) clearTimeout(timer)
      image.removeEventListener('load', check)
      image.removeEventListener('error', onError)
      image.removeAttribute('src')
    }
    image.src = mjpegUrl()
    check()
  }

  const fallBackToMjpeg = () => {
    if (stopped || mjpeg) return
    mjpeg = true
    controller?.abort()
    controller = null
    closeDecoder()
    connecting()
    events.onMjpegFallback(mjpegUrl())
    if (!releaseImage) observeMjpegImage()
  }

  const requestKeyframe = () => {
    if (platform === 'android' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'reset-video', ack: false }))
    }
  }

  const recoverDecoder = () => {
    if (platform === 'ios') {
      fallBackToMjpeg()
    } else {
      closeDecoder()
      connecting('Video decoder restarted.')
      requestKeyframe()
    }
  }

  const makeDecoder = () => {
    const feedGeneration = videoGeneration
    const decoderInstance = new VideoDecoder({
      output: (frame) => {
        try {
          if (
            videoDecoder === decoderInstance &&
            (platform !== 'ios' || feedGeneration === videoGeneration)
          ) {
            decodedVideoGeneration = feedGeneration
            paint(frame, frame.displayWidth, frame.displayHeight)
          }
        } finally {
          frame.close()
        }
      },
      error: () => {
        if (stopped || videoDecoder !== decoderInstance) return
        recoverDecoder()
      },
    })
    return decoderInstance
  }

  const configureDecoder = async (
    config: VideoDecoderConfig,
    isCurrent = () => !stopped,
  ): Promise<boolean> => {
    const epoch = decoderEpoch
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true }
    const support = await VideoDecoder.isConfigSupported(full).catch(() => ({ supported: false }))
    if (!isCurrent() || epoch !== decoderEpoch) return false
    if (!support.supported) {
      if (platform === 'android') fail(`This browser cannot decode ${config.codec}.`)
      return false
    }
    try {
      if (!videoDecoder || videoDecoder.state === 'closed') videoDecoder = makeDecoder()
      videoDecoder.configure(full)
      return true
    } catch (cause) {
      if (platform === 'android') {
        fail(`Video decoder error: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      return false
    }
  }

  const decode = (isKey: boolean, data: Uint8Array, pts?: number | null) => {
    if (!videoDecoder || videoDecoder.state !== 'configured') return
    if (awaitingKeyframe) {
      if (!isKey) return
      awaitingKeyframe = false
    }
    if (videoDecoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      if (platform === 'android') {
        recoverDecoder()
        return
      }
      controller?.abort()
      closeDecoder()
      return
    }
    try {
      videoDecoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: pts ?? timestamp,
          data,
        }),
      )
      timestamp += FRAME_DURATION_US
    } catch {
      recoverDecoder()
    }
  }

  const scheduleRetry = (channel: 'video' | 'input', run: () => void) => {
    if (stopped || retryTimers.has(channel)) return
    retryTimers.set(
      channel,
      setTimeout(() => {
        retryTimers.delete(channel)
        run()
      }, RETRY_DELAY_MS),
    )
  }

  const handleUnauthorized = () => {
    stop()
    events.onInputConnected(false)
    events.onUnauthorized()
  }

  const primeIosHelper = async (session: number) => {
    const prime = new AbortController()
    primeController = prime
    const timeout = setTimeout(() => prime.abort(), 2_000)
    try {
      const response = await fetch(mjpegUrl(), { signal: prime.signal })
      if (stopped || generation !== session) return
      if (response.status === 401 || response.status === 403) return handleUnauthorized()
      await response.body?.getReader().read()
    } catch {
      // Expected abort once primed.
    } finally {
      clearTimeout(timeout)
      prime.abort()
      if (primeController === prime) primeController = null
    }
  }

  const readIosVideo = async () => {
    const lifecycle = generation
    const feedGeneration = ++videoGeneration
    const demuxer = new AvccDemuxer()
    const videoController = new AbortController()
    controller = videoController
    const isCurrent = () =>
      !stopped &&
      generation === lifecycle &&
      videoGeneration === feedGeneration &&
      controller === videoController
    let retryDetail: string | undefined

    try {
      const response = await fetch(httpUrl(`/helper/${encodedDevice}/stream.avcc`), {
        signal: videoController.signal,
      })
      if (!isCurrent()) {
        await response.body?.cancel().catch(() => undefined)
        return
      }
      if (response.status === 401 || response.status === 403) return handleUnauthorized()
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`)
      const reader = response.body.getReader()
      for (;;) {
        const timer = setTimeout(() => {
          if (!isCurrent()) return
          retryDetail = 'Simulator stream stalled. Reconnecting…'
          videoController.abort()
        }, FIRST_FRAME_TIMEOUT_MS)
        videoReadTimer = timer
        let result: ReadableStreamReadResult<Uint8Array>
        try {
          result = await reader.read()
        } finally {
          clearTimeout(timer)
          if (videoReadTimer === timer) videoReadTimer = null
        }
        if (!isCurrent()) return
        if (result.done) break
        for (const chunk of demuxer.push(result.value)) {
          if (videoController.signal.aborted) break
          if (chunk.type === 'seed') {
            void createImageBitmap(new Blob([chunk.payload as BlobPart], { type: 'image/jpeg' }))
              .then((bitmap) => {
                try {
                  if (isCurrent() && decodedVideoGeneration !== feedGeneration) {
                    paint(bitmap, bitmap.width, bitmap.height)
                  }
                } finally {
                  bitmap.close()
                }
              })
              .catch(() => undefined)
          } else if (chunk.type === 'description') {
            awaitingKeyframe = true
            const configured = await configureDecoder(
              {
                codec: avcCodecString(chunk.payload),
                description: chunk.payload,
              },
              isCurrent,
            )
            if (!isCurrent()) return
            if (!configured) {
              await reader.cancel().catch(() => undefined)
              if (isCurrent()) fallBackToMjpeg()
              return
            }
          } else {
            decode(chunk.type === 'keyframe', chunk.payload)
          }
        }
      }
    } catch (cause) {
      if (!isCurrent()) return
      retryDetail ??= videoController.signal.aborted
        ? 'Video decoder fell behind. Reconnecting…'
        : cause instanceof Error
          ? cause.message
          : String(cause)
    }

    if (isCurrent()) {
      controller = null
      videoController.abort()
      closeDecoder()
      connecting(retryDetail)
      scheduleRetry('video', () => void readIosVideo())
    }
  }

  const connectIosInput = async () => {
    if (stopped) return
    const session = generation
    await primeIosHelper(session)
    if (stopped || generation !== session) return
    const ws = new WebSocket(wsUrl(`/helper/ws?device=${encodedDevice}`))
    ws.binaryType = 'arraybuffer'
    socket = ws
    iosInputAdmitted = false
    iosInputUnavailable = false
    ws.onmessage = (event) => {
      if (stopped || socket !== ws || !(event.data instanceof ArrayBuffer)) return
      const bytes = new Uint8Array(event.data)
      if (bytes.length < 1) return
      if (bytes[0] === IOS_TAG_INPUT_ADMITTED) {
        iosInputAdmitted = true
        events.onInputConnected(!iosInputUnavailable)
        return
      }
      if (bytes[0] === IOS_TAG_SCREEN_CONFIG) {
        try {
          const parsed = parseIosScreenConfig(JSON.parse(decoder.decode(bytes.subarray(1))))
          if (parsed) {
            iosInputUnavailable = parsed.inputUnavailable
            events.onInputConnected(
              iosInputAdmitted && !iosInputUnavailable,
              iosInputUnavailable ? 'Simulator input is unavailable' : undefined,
            )
            screen = parsed.screen
            events.onScreen(parsed.screen)
          }
        } catch {
          // Ignore malformed config frames.
        }
      }
    }
    ws.onclose = (event) => {
      if (socket !== ws) return
      socket = null
      iosInputAdmitted = false
      if (stopped) return
      events.onInputConnected(
        false,
        event.reason || (event.code === 1006 ? 'input socket refused' : `closed ${event.code}`),
      )
      if (event.code === 1008 || event.code === 4401) return handleUnauthorized()
      scheduleRetry('input', () => void connectIosInput())
    }
    ws.onerror = () => ws.close()
  }

  const connectAndroid = () => {
    if (stopped) return
    const ws = new WebSocket(wsUrl(`/ws?device=${encodedDevice}&frame-meta=1`))
    ws.binaryType = 'arraybuffer'
    socket = ws
    ws.onopen = () => {
      if (stopped || socket !== ws) return
      connecting()
      events.onInputConnected(true)
    }
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as { type?: unknown }
          if (msg.type === 'video-session') {
            closeDecoder()
            configuring = false
            connecting()
            requestKeyframe()
          }
        } catch {
          // Ignore non-JSON status text.
        }
        return
      }
      if (!(event.data instanceof ArrayBuffer)) return
      const packet = parseSemuPacket(event.data)
      const needsScan =
        packet.isKey === null ||
        (packet.isKey && (!videoDecoder || videoDecoder.state !== 'configured'))
      const scanned = needsScan ? scanAccessUnit(packet.data) : null
      const isKey = packet.isKey ?? scanned?.isKey ?? false
      if (scanned?.sps && (!videoDecoder || videoDecoder.state !== 'configured')) {
        if (configuring) return
        configuring = true
        const epoch = decoderEpoch
        const isCurrent = () => !stopped && socket === ws
        void configureDecoder({ codec: avcCodecString(scanned.sps) }, isCurrent).then(
          (configured) => {
            if (!isCurrent() || epoch !== decoderEpoch) return
            configuring = false
            awaitingKeyframe = true
            if (configured) requestKeyframe()
          },
        )
        return
      }
      if (!videoDecoder || videoDecoder.state !== 'configured') {
        if (!isKey) requestKeyframe()
        return
      }
      decode(isKey, packet.data, packet.timestamp)
    }
    ws.onclose = (event) => {
      if (socket !== ws) return
      socket = null
      closeDecoder()
      if (stopped) return
      events.onInputConnected(false, event.reason || `closed ${event.code}`)
      if (event.code === 1008 || event.code === 4401) return handleUnauthorized()
      configuring = false
      connecting(event.reason || undefined)
      scheduleRetry('input', () => connectAndroid())
    }
    ws.onerror = () => ws.close()
  }

  const start = () => {
    if (!stopped) return
    stopped = false
    generation++
    configuring = false
    iosInputAdmitted = false
    iosInputUnavailable = false
    connecting()
    if (platform === 'ios') {
      void connectIosInput()
      if (useWebCodecs) void readIosVideo()
      else fallBackToMjpeg()
    } else if (useWebCodecs) {
      connectAndroid()
    } else {
      fail('This browser cannot decode the Android stream (WebCodecs unavailable).')
    }
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    generation++
    videoGeneration++
    mjpeg = false
    clearFrameTimer()
    if (videoReadTimer !== null) {
      clearTimeout(videoReadTimer)
      videoReadTimer = null
    }
    releaseImage?.()
    releaseImage = null
    mjpegImage = null
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
    primeController?.abort()
    primeController = null
    controller?.abort()
    controller = null
    const discarded = socket
    socket = null
    discarded?.close()
    closeDecoder()
  }

  const send = (payload: Uint8Array<ArrayBuffer> | string): boolean => {
    if (
      !stopped &&
      (platform !== 'ios' || (iosInputAdmitted && !iosInputUnavailable)) &&
      socket?.readyState === WebSocket.OPEN
    ) {
      socket.send(payload)
      return true
    }
    return false
  }

  const rawPoint = (x: number, y: number) => {
    if (platform !== 'ios' || !screen || screen.width > screen.height) return { x, y }
    switch (screen.orientation) {
      case 'landscape_left':
        return { x: y, y: 1 - x }
      case 'landscape_right':
        return { x: 1 - y, y: x }
      case 'portrait_upside_down':
        return { x: 1 - x, y: 1 - y }
      default:
        return { x, y }
    }
  }

  return {
    start,
    stop,
    setMjpegImage(image) {
      if (mjpegImage === image) return
      releaseImage?.()
      releaseImage = null
      mjpegImage = image
      observeMjpegImage()
    },
    sendTouch(phase, x, y) {
      if (platform === 'ios') {
        send(taggedJson(IOS_MSG_TOUCH, { type: phase, ...rawPoint(x, y) }))
        return
      }
      const action = phase === 'begin' ? 'down' : phase === 'move' ? 'move' : 'up'
      send(JSON.stringify({ type: 'touch', action, x, y }))
    },
    sendKey(event, phase) {
      if (platform === 'ios') {
        const message = iosKeyMessageForEvent(event, phase)
        if (!message) return false
        return send(taggedJson(IOS_MSG_KEY, message))
      }
      if (phase !== 'down') return false
      if (event.key === 'Escape') {
        return send(JSON.stringify({ type: 'back' }))
      }
      const keycode = ANDROID_KEYCODE_BY_KEY.get(event.key)
      if (keycode !== undefined) {
        return send(JSON.stringify({ type: 'key', keycode }))
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        return send(JSON.stringify({ type: 'text', text: event.key }))
      }
      return false
    },
    sendMetaChord(code, shiftKey = false) {
      if (platform !== 'ios') return false
      const usage = hidUsageForCode(code)
      if (usage === null) return false
      if (!send(taggedJson(IOS_MSG_KEY, { type: 'down', usage: HID_USAGE_META_LEFT }))) {
        return false
      }
      if (shiftKey) {
        send(taggedJson(IOS_MSG_KEY, { type: 'down', usage: HID_USAGE_SHIFT_LEFT }))
      }
      send(taggedJson(IOS_MSG_KEY, { type: 'down', usage }))
      send(taggedJson(IOS_MSG_KEY, { type: 'up', usage }))
      if (shiftKey) {
        send(taggedJson(IOS_MSG_KEY, { type: 'up', usage: HID_USAGE_SHIFT_LEFT }))
      }
      send(taggedJson(IOS_MSG_KEY, { type: 'up', usage: HID_USAGE_META_LEFT }))
      return true
    },
    sendText(text) {
      if (text.length === 0) return
      if (platform === 'ios') {
        const frame = taggedJson(IOS_MSG_PASTE, { requestId: ++pasteRequestId, text })
        if (frame.byteLength <= IOS_MAX_INPUT_FRAME_BYTES) send(frame)
        return
      }
      let chunk = ''
      let chunkBytes = 0
      let sentChunks = 0
      for (const character of text) {
        const characterBytes = utf8ByteLength(character.codePointAt(0)!)
        if (chunkBytes + characterBytes > ANDROID_MAX_TEXT_BYTES) {
          send(JSON.stringify({ type: 'text', text: chunk }))
          if (++sentChunks >= ANDROID_MAX_TEXT_CHUNKS) return
          chunk = ''
          chunkBytes = 0
        }
        chunk += character
        chunkBytes += characterBytes
      }
      if (chunk.length > 0) send(JSON.stringify({ type: 'text', text: chunk }))
    },
    pressButton(button) {
      if (platform === 'ios') {
        const name =
          button === 'home'
            ? 'home'
            : button === 'appSwitcher' || button === 'recents'
              ? 'app_switcher'
              : button === 'power'
                ? 'lock'
                : null
        if (name) send(taggedJson(IOS_MSG_BUTTON, { button: name }))
        return
      }
      const type = button === 'appSwitcher' ? 'recents' : button
      if (type === 'home' || type === 'back' || type === 'recents' || type === 'power') {
        send(JSON.stringify({ type }))
      }
    },
    rotate() {
      if (platform !== 'ios') return
      const current = screen?.orientation ?? 'portrait'
      const next =
        IOS_ORIENTATIONS[(IOS_ORIENTATIONS.indexOf(current) + 1) % IOS_ORIENTATIONS.length]!
      send(taggedJson(IOS_MSG_ORIENTATION, { orientation: next }))
    },
  }
}
