import { request, WebSocket } from 'node:http'

/**
 * Port-conflict handling for the owned core server.
 *
 * When the packaged app starts while something already holds the server port,
 * two very different situations look identical to the supervisor's crash
 * counter: a leftover TasteCode server from a killed run (the renderer can
 * simply use it — the protocol is loopback-only) and a foreign process that
 * will never speak our protocol (the renderer reconnects forever while a
 * generic "keeps crashing" dialog blames the wrong thing).
 *
 * The probe is two-stage. The server's plain-HTTP fingerprint answers every
 * non-upgrade request with 426 Upgrade Required — almost nothing else does —
 * but the 426 response carries no version, so it cannot distinguish a
 * same-build leftover from a stale one whose wire shapes no longer match.
 * The follow-up opens a WebSocket: the server greets every accepted socket
 * with a server.welcome push carrying its PROTOCOL_VERSION, and only a
 * matching version counts as adoptable.
 */

/** Extract the busy port from the server's EADDRINUSE line, if that is what it is. */
export function parsePortConflict(line: string): number | undefined {
  const match = /port (\d{1,5}) is already in use/.exec(line)
  if (!match) return undefined
  const port = Number(match[1])
  return port >= 1 && port <= 65_535 ? port : undefined
}

/** What a plain HTTP probe found holding the port. */
export type PortOwner = 'harness' | 'foreign' | 'unknown'

/** 426 Upgrade Required is the core server's answer to non-WebSocket HTTP. */
export function classifyPortResponse(statusCode: number | undefined): PortOwner {
  if (statusCode === 426) return 'harness'
  if (statusCode === undefined) return 'unknown'
  return 'foreign'
}

/** The protocol version a server.welcome push frame carries, if it is one. */
export function welcomeProtocolVersion(frame: unknown): number | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  if (!('channel' in frame) || frame.channel !== 'server.welcome') return undefined
  if (!('data' in frame) || typeof frame.data !== 'object' || frame.data === null) {
    return undefined
  }
  if (!('protocolVersion' in frame.data)) return undefined
  const version = frame.data.protocolVersion
  return typeof version === 'number' && Number.isFinite(version) ? version : undefined
}

/** The HTTP status a plain GET on the port answers with, or none. */
function probeHttpStatus(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const probe = request({ host, port, path: '/', method: 'GET', timeout: timeoutMs })
    probe.on('response', (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    probe.on('timeout', () => {
      probe.destroy()
      resolve(undefined)
    })
    probe.on('error', () => resolve(undefined))
    probe.end()
  })
}

/** The first text frame a WebSocket on this port pushes, or none. */
function firstPushedFrame(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://${host}:${port}/`)
    } catch {
      resolve(undefined)
      return
    }
    const finish = (frame: string | undefined): void => {
      clearTimeout(timer)
      resolve(frame)
      try {
        socket.close()
      } catch {
        // A socket that never opened is already gone.
      }
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    socket.addEventListener('message', (event) =>
      finish(typeof event.data === 'string' ? event.data : undefined),
    )
    socket.addEventListener('error', () => finish(undefined))
    socket.addEventListener('close', () => finish(undefined))
  })
}

/**
 * Whether the port's owner is this build's server. The HTTP probe separates
 * foreign from unreachable cheaply; only a 426 earns the WebSocket follow-up
 * that proves the peer speaks our protocol at the expected version. Anything
 * unproven stays 'unknown' so the supervisor keeps its normal restart path.
 */
export async function probePortOwner(
  host: string,
  port: number,
  expectedProtocolVersion: number,
  timeoutMs = 1500,
): Promise<PortOwner> {
  const owner = classifyPortResponse(await probeHttpStatus(host, port, timeoutMs))
  if (owner !== 'harness') return owner
  const frame = await firstPushedFrame(host, port, timeoutMs)
  if (frame === undefined) return 'unknown'
  let parsed: unknown
  try {
    parsed = JSON.parse(frame)
  } catch {
    return 'foreign'
  }
  return welcomeProtocolVersion(parsed) === expectedProtocolVersion ? 'harness' : 'foreign'
}
