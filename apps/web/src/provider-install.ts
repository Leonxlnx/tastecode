import type { ProviderId } from '@harness/contracts'
import type { Transport } from './transport.js'

/**
 * Provider installs in flight, tracked outside React on purpose: an install
 * keeps running on the server while the user closes Settings or navigates
 * away, and the row has to show the truth when they come back. One entry per
 * install target, gone again once the install succeeded and the provider list
 * confirmed it.
 */

export type InstallState = {
  phase: 'running' | 'succeeded' | 'failed'
  terminalId: string
  /** Raw pty output so an attached terminal can replay the whole run. */
  log: string
  /** Last printable line, for the settings row note. */
  lastLine: string
  exitCode: number | null
}

export type InstallTarget = { provider: ProviderId; agent?: string }

export function installKey(target: InstallTarget): string {
  return target.agent ? `${target.provider}:${target.agent}` : target.provider
}

/**
 * Interactive sign-in sessions share the install store — same lifecycle, same
 * attachable terminal — but never the same entry, so an install and a login
 * for one target cannot clobber each other.
 */
export function loginKey(target: InstallTarget): string {
  return `login:${installKey(target)}`
}

const LOG_CAP = 200_000

const installs = new Map<string, InstallState>()
const listeners = new Set<() => void>()

export function subscribeInstalls(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function installState(key: string): InstallState | undefined {
  return installs.get(key)
}

export function clearInstall(key: string): void {
  if (installs.delete(key)) notify()
}

/** Test isolation only: module state must not leak between test cases. */
export function resetInstalls(): void {
  installs.clear()
  notify()
}

/**
 * Start (or reattach to) a background install. The server keys the terminal
 * by target, so calling this twice while one is running attaches to the same
 * session rather than installing twice.
 */
export async function beginInstall(transport: Transport, target: InstallTarget): Promise<void> {
  return begin(transport, 'providers.install', target, installKey(target))
}

/**
 * Start (or reattach to) an interactive sign-in session: the provider's own
 * CLI running in a server-side pty, where the user completes the OAuth flow.
 */
export async function beginLogin(transport: Transport, target: InstallTarget): Promise<void> {
  return begin(transport, 'providers.launch', target, loginKey(target))
}

async function begin(
  transport: Transport,
  method: 'providers.install' | 'providers.launch',
  target: InstallTarget,
  key: string,
): Promise<void> {
  const existing = installs.get(key)
  if (existing?.phase === 'running') return

  const { terminalId } = await transport.request(method, {
    provider: target.provider,
    ...(target.agent ? { agent: target.agent } : {}),
    columns: 100,
    rows: 30,
  })

  const state: InstallState = {
    phase: 'running',
    terminalId,
    log: '',
    lastLine: '',
    exitCode: null,
  }
  installs.set(key, state)
  notify()

  const offOutput = transport.on('terminal.output', (event) => {
    const current = installs.get(key)
    if (!current || event.terminalId !== terminalId) return
    let log = current.log + event.data
    if (log.length > LOG_CAP) log = log.slice(log.length - LOG_CAP)
    installs.set(key, { ...current, log, lastLine: lastPrintableLine(log) })
    notify()
  })
  const offExit = transport.on('terminal.exit', (event) => {
    if (event.terminalId !== terminalId) return
    offOutput()
    offExit()
    const current = installs.get(key)
    if (!current) return
    installs.set(key, {
      ...current,
      phase: event.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: event.exitCode,
    })
    notify()
  })
}

function notify(): void {
  for (const listener of listeners) listener()
}

// CSI sequences, OSC sequences (title updates and the like), then any stray
// control byte that is not a newline. Enough to turn pty output into a note.
const ANSI =
  /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g

export function lastPrintableLine(log: string): string {
  const lines = log.replace(ANSI, '').split(/\r\n|\n|\r/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (line) return line
  }
  return ''
}
