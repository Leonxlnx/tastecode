import process from 'node:process'
import { DEFAULT_PORT } from './server-config.js'

type CliOptions = {
  command: 'serve' | 'help'
  port: number
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

  const { startServer } = await import('./server.js')
  const server = startServer({
    port: options.port,
    host: '127.0.0.1',
    accessToken: env['HARNESS_ACCESS_TOKEN'],
  })
  installShutdownHandlers(server)
  process.stdout.write('Harness is running without the desktop app.\n')
}

export function parseCliOptions(args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let command: CliOptions['command'] = 'serve'
  let port = parsePort(env['HARNESS_PORT'] ?? String(DEFAULT_PORT), 'HARNESS_PORT')
  let commandSeen = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === 'serve') {
      if (commandSeen) throw new Error('The `serve` command may only be specified once.')
      command = argument
      commandSeen = true
      continue
    }
    if (argument === 'help' || argument === '--help' || argument === '-h') {
      command = 'help'
      continue
    }
    if (argument === '--port') {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a port number.`)
      port = parsePort(value, argument)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  return { command, port }
}

function parsePort(value: string, source: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${source} must be a whole port number.`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be between 1 and 65535.`)
  }
  return port
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

function helpText(): string {
  return `Harness headless CLI

Usage:
  harness serve [--port <port>]

Commands:
  serve  Run the core server without Electron or the web renderer.

Environment:
  HARNESS_PORT          Local control port (default: ${DEFAULT_PORT})
  HARNESS_ACCESS_TOKEN  Optional token for the loopback control socket
  HARNESS_DATA_DIR      Override the server data directory
`
}
