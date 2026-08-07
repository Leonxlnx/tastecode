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
  /** Auth URL detected in a sign-in session and already opened for the user. */
  openedAuthUrl?: string
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
  detachTransportListeners(key)
  if (installs.delete(key)) notify()
}

/** Test isolation only: module state must not leak between test cases. */
export function resetInstalls(): void {
  for (const key of [...transportListeners.keys()]) detachTransportListeners(key)
  installs.clear()
  notify()
}

/**
 * Transport subscriptions per session. A pty that never reports exit would
 * otherwise leak its output listener (and the rolling log it feeds) for the
 * lifetime of the app.
 */
const transportListeners = new Map<string, Array<() => void>>()

function detachTransportListeners(key: string): void {
  for (const off of transportListeners.get(key) ?? []) off()
  transportListeners.delete(key)
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
 * CLI running in a server-side pty. The first URL the CLI prints is its OAuth
 * link — it gets opened for the user automatically, so the flow is "click
 * Sign in, approve in the browser" with the terminal only as a fallback.
 */
export async function beginLogin(
  transport: Transport,
  target: InstallTarget,
  openUrl: (url: string) => void = (url) => window.open(url, '_blank', 'noopener,noreferrer'),
): Promise<void> {
  return begin(transport, 'providers.launch', target, loginKey(target), openUrl)
}

/**
 * The first http(s) URL in a log, after stripping terminal control noise.
 *
 * Only a *terminated* URL counts: pty chunks split at arbitrary byte
 * boundaries, and matching a chunk that ends mid-URL would open a truncated
 * link and latch it as "already opened", blocking the real one forever. The
 * login pty is spawned wide (LOGIN_COLUMNS) so URLs never soft-wrap
 * mid-line, making the trailing whitespace or quote a reliable terminator.
 */
export function firstAuthUrl(log: string): string | undefined {
  const printable = log.replace(ANSI, '')
  const match = /(https?:\/\/[^\s'"<>)]+)[\s'"<>)]/.exec(printable)
  return match?.[1]
}

/**
 * The device/user code a sign-in CLI asks the user to confirm in the browser.
 *
 * URLs are stripped first — OAuth links often carry the code as a path or
 * query segment, and matching inside them would show a chip before the CLI
 * has actually presented a code. A labelled form ("code: XXXX-XXXX") wins
 * over the bare dashed pattern; both must be upper-case or digits so prose
 * never matches. Absence just means no chip — the URL flow still works.
 */
export function deviceCode(log: string): string | undefined {
  const printable = log.replace(ANSI, '').replace(/https?:\/\/[^\s'"<>)]+/g, ' ')
  const labeled =
    /code[^\S\r\n]*[:=]?[^\S\r\n]+([A-Z0-9]{3,5}-[A-Z0-9]{3,5}|\d{6,9})(?![\w-])/i.exec(printable)
  if (labeled) return labeled[1]
  const dashed = /\b([A-Z0-9]{4}-[A-Z0-9]{4})(?![\w-])/.exec(printable)
  return dashed?.[1]
}

/** Wide enough that no OAuth URL soft-wraps; an attached terminal resizes. */
const LOGIN_COLUMNS = 320

async function begin(
  transport: Transport,
  method: 'providers.install' | 'providers.launch',
  target: InstallTarget,
  key: string,
  openUrl?: (url: string) => void,
): Promise<void> {
  const existing = installs.get(key)
  if (existing?.phase === 'running') return

  const { terminalId } = await transport.request(method, {
    provider: target.provider,
    ...(target.agent ? { agent: target.agent } : {}),
    // Logins get a wide pty so the OAuth URL is printed on one line — the
    // URL detector depends on that. Installs render at a normal width.
    columns: method === 'providers.launch' ? LOGIN_COLUMNS : 100,
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

  // A retry replaces the session; the old session's listeners go with it.
  detachTransportListeners(key)
  const offOutput = transport.on('terminal.output', (event) => {
    const current = installs.get(key)
    if (!current || event.terminalId !== terminalId) return
    let log = current.log + event.data
    if (log.length > LOG_CAP) log = log.slice(log.length - LOG_CAP)
    let openedAuthUrl = current.openedAuthUrl
    if (openUrl && !openedAuthUrl) {
      const url = firstAuthUrl(log)
      if (url) {
        openedAuthUrl = url
        openUrl(url)
      }
    }
    installs.set(key, {
      ...current,
      log,
      lastLine: lastPrintableLine(log),
      ...(openedAuthUrl ? { openedAuthUrl } : {}),
    })
    notify()
  })
  const offExit = transport.on('terminal.exit', (event) => {
    if (event.terminalId !== terminalId) return
    detachTransportListeners(key)
    const current = installs.get(key)
    if (!current) return
    installs.set(key, {
      ...current,
      phase: event.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: event.exitCode,
    })
    notify()
  })
  transportListeners.set(key, [offOutput, offExit])
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
