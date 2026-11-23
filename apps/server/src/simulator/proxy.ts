import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Readable } from 'node:stream'
import { SIMULATOR_HUB_ROUTE_PREFIX } from '@harness/contracts'
import { WebSocket, WebSocketServer } from 'ws'
import { MjpegStillFrameTransform } from './mjpeg-still-frame.js'
import type { SimulatorService } from './service.js'

/**
 * Loopback-only `expo-device-hub` exposes a shell-exec route on serve-sim and
 * unauthenticated action routes on serve-emu. This proxy exposes ONLY an
 * allowlist of video stream, accessibility, screenshot, and input routes, and
 * requires a server-minted hub ticket plus Origin validation on every request.
 */
const ALLOWED_GET_PATHS: readonly RegExp[] = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|accessibility)$/,
  /^\/vendor\/serve-emu\/health$/,
]

const ALLOWED_POST_PATHS: readonly RegExp[] = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-emu\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings|fold)$/,
]

const ALLOWED_WS_PATHS: readonly RegExp[] = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
]

const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'cookie',
  'authorization',
  'content-length',
  'accept-encoding',
  'x-forwarded-proto',
])

const DROPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'transfer-encoding',
  'connection',
  'set-cookie',
  'cache-control',
  'vary',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'access-control-max-age',
])

export type SimulatorProxyOptions = {
  readonly simulator: SimulatorService
  readonly allowedOrigin: (origin: string | undefined) => boolean
}

function isProxyOriginAllowed(
  origin: string | undefined,
  hasValidTicket: boolean,
  allowedOrigin: (origin: string | undefined) => boolean,
): boolean {
  if (allowedOrigin(origin)) return true
  // Packaged Electron renderer (`file://`) sends `Origin: null` on CORS fetch.
  // Allow it ONLY when accompanied by a cryptographic hub ticket minted over
  // the Origin-checked control socket (see rules/security.md).
  return origin === 'null' && hasValidTicket
}

type CorsHeaders = {
  readonly 'access-control-allow-origin'?: string
  readonly 'access-control-allow-methods'?: string
  readonly 'access-control-allow-headers'?: string
  readonly vary?: string
}

function corsHeaders(origin: string | undefined): CorsHeaders {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin === 'null' ? '*' : origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    vary: 'Origin',
  }
}

function parseHubUrl(
  rawUrl: string | undefined,
): { hubPath: string; params: URLSearchParams } | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl, 'http://127.0.0.1')
    if (!parsed.pathname.startsWith(SIMULATOR_HUB_ROUTE_PREFIX)) return null
    const rest = parsed.pathname.slice(SIMULATOR_HUB_ROUTE_PREFIX.length)
    // Reject path traversal segments before matching against the allowlist.
    if (rest.includes('..') || rest.includes('\\') || rest.includes('\0')) return null
    return {
      hubPath: rest || '/',
      params: parsed.searchParams,
    }
  } catch {
    return null
  }
}

export function createSimulatorHubProxy(options: SimulatorProxyOptions) {
  let proxyWss: WebSocketServer | undefined
  const getProxyWss = () => (proxyWss ??= new WebSocketServer({ noServer: true }))

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const parsed = parseHubUrl(req.url)
    if (!parsed) return false

    const origin = req.headers.origin
    const ticket = parsed.params.get('ticket')
    const validTicket = options.simulator.verifyHubTicket(ticket)

    if (req.method === 'OPTIONS') {
      if (!isProxyOriginAllowed(origin, validTicket, options.allowedOrigin)) {
        res.writeHead(403).end('Forbidden')
        return true
      }
      res.writeHead(204, corsHeaders(origin)).end()
      return true
    }

    if (!validTicket || !isProxyOriginAllowed(origin, validTicket, options.allowedOrigin)) {
      res.writeHead(401, corsHeaders(origin)).end('Unauthorized')
      return true
    }

    const method = req.method ?? 'GET'
    const isRead = method === 'GET' || method === 'HEAD'
    const allowed = isRead
      ? ALLOWED_GET_PATHS.some((pattern) => pattern.test(parsed.hubPath))
      : method === 'POST' && ALLOWED_POST_PATHS.some((pattern) => pattern.test(parsed.hubPath))

    if (!allowed) {
      const existsInOther =
        ALLOWED_GET_PATHS.some((pattern) => pattern.test(parsed.hubPath)) ||
        ALLOWED_POST_PATHS.some((pattern) => pattern.test(parsed.hubPath))
      res
        .writeHead(existsInOther ? 405 : 404, corsHeaders(origin))
        .end(existsInOther ? 'Method Not Allowed' : 'Not Found')
      return true
    }

    const ready = options.simulator.currentHost()
    if (!ready) {
      res.writeHead(503, corsHeaders(origin)).end('Simulator hub is not running')
      return true
    }

    // Strip the TasteCode ticket before forwarding upstream.
    const upstreamParams = new URLSearchParams(parsed.params)
    upstreamParams.delete('ticket')
    const search = upstreamParams.size > 0 ? `?${upstreamParams.toString()}` : ''

    // Route screenshots through SimulatorService so Xcode 26 fallback applies uniformly.
    const screenshotDevice = upstreamParams.get('device')
    if (
      screenshotDevice &&
      (parsed.hubPath === '/vendor/serve-sim/api/screenshot' ||
        parsed.hubPath === '/vendor/serve-emu/api/screenshot')
    ) {
      try {
        const { png } = await options.simulator.screenshot(screenshotDevice)
        res.writeHead(200, {
          ...corsHeaders(origin),
          'content-type': 'image/png',
          'cache-control': 'no-store, no-transform',
          'content-length': String(png.byteLength),
        })
        res.end(Buffer.from(png))
      } catch (error) {
        res
          .writeHead(502, corsHeaders(origin))
          .end(error instanceof Error ? error.message : 'Screenshot failed')
      }
      return true
    }

    const upstreamUrl = `${ready.origin}${parsed.hubPath}${search}`
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase()) || value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    if (origin !== undefined) headers['origin'] = ready.origin

    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    req.once('close', abortUpstream)
    res.once('close', abortUpstream)

    try {
      let body: Buffer | undefined
      if (!isRead) {
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += buf.length
          if (total > 2 * 1024 * 1024) {
            res.writeHead(413, corsHeaders(origin)).end('Payload Too Large')
            return true
          }
          chunks.push(buf)
        }
        body = Buffer.concat(chunks)
      }

      const upstreamRes = await fetch(upstreamUrl, {
        method,
        headers,
        ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
        signal: controller.signal,
      })

      upstreamRes.headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
          res.setHeader(name, value)
        }
      })
      const cors = corsHeaders(origin)
      for (const [name, value] of Object.entries(cors)) {
        if (value !== undefined) res.setHeader(name, value)
      }
      res.setHeader('cache-control', 'no-store, no-transform')

      res.writeHead(upstreamRes.status)
      if (!upstreamRes.body || method === 'HEAD') {
        res.end()
        return true
      }

      const nodeStream = Readable.from(upstreamRes.body)
      const contentType = upstreamRes.headers.get('content-type') ?? ''
      if (contentType.startsWith('multipart/x-mixed-replace')) {
        const mjpeg = new MjpegStillFrameTransform()
        nodeStream.on('error', () => mjpeg.destroy())
        mjpeg.on('error', () => res.destroy())
        nodeStream.pipe(mjpeg).pipe(res)
      } else {
        nodeStream.on('error', () => res.destroy())
        nodeStream.pipe(res)
      }
    } catch (error) {
      if (!res.headersSent) {
        const status = controller.signal.aborted ? 499 : 502
        res
          .writeHead(status, corsHeaders(origin))
          .end(error instanceof Error ? error.message : 'Upstream request failed')
      } else {
        res.destroy()
      }
    } finally {
      req.off('close', abortUpstream)
      res.off('close', abortUpstream)
    }
    return true
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const parsed = parseHubUrl(req.url)
    if (!parsed) return false

    const ticket = parsed.params.get('ticket')
    const validTicket = options.simulator.verifyHubTicket(ticket)
    if (
      !validTicket ||
      !isProxyOriginAllowed(req.headers.origin, validTicket, options.allowedOrigin)
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }

    if (!ALLOWED_WS_PATHS.some((pattern) => pattern.test(parsed.hubPath))) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }

    const ready = options.simulator.currentHost()
    if (!ready) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }

    const upstreamParams = new URLSearchParams(parsed.params)
    upstreamParams.delete('ticket')
    const search = upstreamParams.size > 0 ? `?${upstreamParams.toString()}` : ''
    const wsOrigin = ready.origin.replace(/^http/, 'ws')
    const upstreamUrl = `${wsOrigin}${parsed.hubPath}${search}`

    getProxyWss().handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(upstreamUrl)
      const pending: Array<{ data: Buffer | string; isBinary: boolean }> = []

      const closeBoth = (code = 1000, reason = '') => {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          try {
            client.close(code >= 1000 && code < 5000 ? code : 1000, reason.slice(0, 120))
          } catch {
            client.terminate()
          }
        }
        if (
          upstream.readyState === WebSocket.OPEN ||
          upstream.readyState === WebSocket.CONNECTING
        ) {
          try {
            upstream.close()
          } catch {
            upstream.terminate()
          }
        }
      }

      upstream.on('open', () => {
        for (const frame of pending.splice(0)) {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(frame.data, { binary: frame.isBinary })
          }
        }
      })

      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: isBinary })
        }
      })

      client.on('message', (data, isBinary) => {
        const normalized = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data)
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(normalized, { binary: isBinary })
        } else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 128) {
          pending.push({ data: normalized, isBinary })
        }
      })

      upstream.on('close', (code, reason) => closeBoth(code, reason.toString('utf8')))
      upstream.on('error', () => closeBoth(1011, 'upstream error'))
      client.on('close', () => closeBoth())
      client.on('error', () => closeBoth())
    })
    return true
  }

  function close(): void {
    if (!proxyWss) return
    for (const client of proxyWss.clients) client.terminate()
    proxyWss.close()
    proxyWss = undefined
  }

  return { handleHttp, handleUpgrade, close }
}
