import { randomUUID } from 'node:crypto'
import process from 'node:process'
import * as QRCode from 'qrcode'
import { methods, type ResultOf } from '@harness/contracts'
import { WebSocket } from 'ws'
import { DEFAULT_PORT } from './server-config.js'

const DEFAULT_PAIRING_TIMEOUT_MS = 1_500

type PairingOffer = ResultOf<'connections.startPairing'>

type CliOptions = {
  command: 'serve' | 'pair' | 'help'
  port: number
  mobilePort: number | undefined
  showQr: boolean
}

export async function runHeadlessCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseCliOptions(args, env)
  if (options.command === 'help') {
    process.stdout.write(helpText())
    return
  }

  const accessToken = env['HARNESS_ACCESS_TOKEN']
  if (options.command === 'pair') {
    const existingOffer = await requestPairingFromRunningServer(
      options.port,
      accessToken,
      DEFAULT_PAIRING_TIMEOUT_MS,
    )
    if (existingOffer) {
      await printPairingOffer(existingOffer, options.showQr)
      return
    }
  }

  // Keep the server's orchestration and SQLite graph out of `help` and the
  // common case where this process only asks an existing server to pair.
  const { startServer } = await import('./server.js')
  const server = startServer({
    port: options.port,
    host: '127.0.0.1',
    accessToken,
    ...(options.mobilePort === undefined ? {} : { mobilePort: options.mobilePort }),
  })
  installShutdownHandlers(server)

  if (options.command === 'pair') {
    try {
      const offer = await server.startPairing()
      await printPairingOffer(offer, options.showQr)
      process.stdout.write(
        '\nThe headless server is now running. Keep this process open; run `harness pair` in ' +
          'another terminal whenever you need a fresh link.\n',
      )
    } catch (error) {
      await server.close()
      throw error
    }
    return
  }

  process.stdout.write(
    'Harness is running without the desktop app. Run `harness pair` in another terminal to ' +
      'connect Harness Mobile.\n',
  )
}

export function parseCliOptions(args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let command: CliOptions['command'] = 'serve'
  let port = parsePort(env['HARNESS_PORT'] ?? String(DEFAULT_PORT), 'HARNESS_PORT')
  let mobilePort = env['HARNESS_MOBILE_PORT']
    ? parsePort(env['HARNESS_MOBILE_PORT'], 'HARNESS_MOBILE_PORT')
    : undefined
  let showQr = true
  let commandSeen = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === 'serve' || argument === 'pair') {
      if (commandSeen) throw new Error('Choose either `serve` or `pair`, not both.')
      command = argument
      commandSeen = true
      continue
    }
    if (argument === 'help' || argument === '--help' || argument === '-h') {
      command = 'help'
      continue
    }
    if (argument === '--no-qr') {
      showQr = false
      continue
    }
    if (argument === '--port' || argument === '--mobile-port') {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a port number.`)
      const parsed = parsePort(value, argument)
      if (argument === '--port') port = parsed
      else mobilePort = parsed
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (mobilePort !== undefined && mobilePort === port) {
    throw new Error('The control and mobile listeners must use different ports.')
  }
  return { command, port, mobilePort, showQr }
}

export async function requestPairingFromRunningServer(
  port: number,
  accessToken: string | undefined,
  timeoutMs = DEFAULT_PAIRING_TIMEOUT_MS,
): Promise<PairingOffer | undefined> {
  const url = new URL(`ws://127.0.0.1:${port}`)
  if (accessToken) url.searchParams.set('token', accessToken)

  return new Promise<PairingOffer | undefined>((resolve, reject) => {
    const socket = new WebSocket(url)
    const requestId = randomUUID()
    let opened = false
    let requestSent = false
    let settled = false

    const timer = setTimeout(() => {
      finish(new Error(`Timed out while connecting to the Harness server on port ${port}.`))
    }, timeoutMs)

    const finish = (result: PairingOffer | Error | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate()
      }
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    socket.once('open', () => {
      opened = true
    })
    socket.on('message', (raw) => {
      let frame: unknown
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        finish(new Error(`Port ${port} is open, but it is not a Harness server.`))
        return
      }

      if (isWelcomeFrame(frame) && !requestSent) {
        requestSent = true
        socket.send(
          JSON.stringify({ id: requestId, method: 'connections.startPairing', params: {} }),
        )
        return
      }
      if (!isResponseFrame(frame) || frame.id !== requestId) return
      if ('error' in frame) {
        finish(
          new Error(
            `The running Harness server could not create a pairing link: ${frame.error.message}`,
          ),
        )
        return
      }
      const parsed = methods['connections.startPairing'].result.safeParse(frame.result)
      if (!parsed.success) {
        finish(new Error('The running Harness server returned an invalid pairing response.'))
        return
      }
      finish(parsed.data)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (!opened && error.code === 'ECONNREFUSED') {
        finish(undefined)
        return
      }
      finish(new Error(`Could not use the Harness server on port ${port}: ${error.message}`))
    })
    socket.once('close', (code, reason) => {
      if (settled) return
      if (!opened && code === 1006) {
        finish(undefined)
        return
      }
      finish(
        new Error(
          code === 1008
            ? 'The running Harness server refused local CLI access. Restart it so it loads the latest headless pairing support.'
            : `The Harness server closed before pairing (${code}${reason.length ? `: ${reason.toString()}` : ''}).`,
        ),
      )
    })
  })
}

export function pairingMessage(offer: PairingOffer, terminalQr?: string): string {
  const expires = new Date(offer.expiresAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  const routes = offer.addresses.map((address) => address.label).join(', ')
  return [
    '',
    `Pair ${offer.serverName} with Harness Mobile${terminalQr ? `:\n${terminalQr}` : '.'}`,
    '',
    'Paste this one-time link on the phone if you cannot scan the terminal:',
    offer.pairingUri,
    '',
    `Expires at ${expires}. Available through ${routes}. Do not share this link.`,
    '',
  ].join('\n')
}

function parsePort(value: string, source: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${source} must be a whole port number.`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be between 1 and 65535.`)
  }
  return port
}

async function printPairingOffer(offer: PairingOffer, showQr: boolean): Promise<void> {
  const terminalQr =
    showQr && process.stdout.isTTY
      ? await QRCode.toString(offer.pairingUri, { type: 'terminal', small: true })
      : undefined
  process.stdout.write(pairingMessage(offer, terminalQr))
}

function installShutdownHandlers(server: { close(): Promise<void> }): void {
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (closing) return
      closing = true
      void server.close().finally(() => process.exit(0))
    })
  }
}

function isWelcomeFrame(value: unknown): value is { channel: 'server.welcome' } {
  return isRecord(value) && value['channel'] === 'server.welcome'
}

function isResponseFrame(
  value: unknown,
): value is { id: string; result: unknown } | { id: string; error: { message: string } } {
  if (!isRecord(value) || typeof value['id'] !== 'string') return false
  if ('result' in value) return true
  return isRecord(value['error']) && typeof value['error']['message'] === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function helpText(): string {
  return `Harness headless CLI

Usage:
  harness serve [--port <port>] [--mobile-port <port>]
  harness pair [--port <port>] [--mobile-port <port>] [--no-qr]

Commands:
  serve  Run the core server without Electron or the web renderer.
  pair   Ask a running server for a one-time mobile link, or start a headless
         server and print the link when none is running.

Environment:
  HARNESS_PORT          Local control port (default: ${DEFAULT_PORT})
  HARNESS_MOBILE_PORT   Private LAN/Tailscale mobile port (default: control + 1)
  HARNESS_ACCESS_TOKEN  Optional token for the loopback control socket
  HARNESS_DATA_DIR      Override the server data directory
`
}
