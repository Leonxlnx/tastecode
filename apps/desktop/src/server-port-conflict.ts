import { request } from 'node:http'

/**
 * Port-conflict handling for the owned core server.
 *
 * When the packaged app starts while something already holds the server port,
 * two very different situations look identical to the supervisor's crash
 * counter: a leftover TasteCode server from a killed run (the renderer can
 * simply use it — the protocol is loopback-only and identical) and a foreign
 * process that will never speak our protocol (the renderer reconnects forever
 * while a generic "keeps crashing" dialog blames the wrong thing).
 *
 * The server's plain-HTTP response is a fingerprint: it answers every
 * non-upgrade request with 426 Upgrade Required, which almost nothing else
 * does. Probing once lets the desktop adopt a compatible listener or name the
 * port for the user instead of retrying into the same wall.
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

export function probePortOwner(host: string, port: number, timeoutMs = 1500): Promise<PortOwner> {
  return new Promise((resolve) => {
    const probe = request({ host, port, path: '/', method: 'GET', timeout: timeoutMs })
    probe.on('response', (response) => {
      response.resume()
      resolve(classifyPortResponse(response.statusCode))
    })
    probe.on('timeout', () => {
      probe.destroy()
      resolve('unknown')
    })
    probe.on('error', () => resolve('unknown'))
    probe.end()
  })
}
