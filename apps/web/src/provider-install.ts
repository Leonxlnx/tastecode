import type { DataOf, ProviderId } from '@harness/contracts'
import type { Transport } from './transport.js'

/**
 * Provider installs in flight, tracked outside React on purpose: an install
 * keeps running on the server while the user closes Settings or navigates
 * away, and the row has to show the truth when they come back. One entry per
 * install target, gone again once the install succeeded and the provider list
 * confirmed it.
 */

export type InstallState = {
  phase: 'running' | 'succeeded' | 'failed' | 'canceled'
  canceling?: boolean
  terminalId: string
  /** Raw pty output so an attached terminal can replay the whole run. */
  log: string
  /** Absolute character position of the first retained character. */
  logOffset: number
  /** Last printable line, for the settings row note. */
  lastLine: string
  /** Auth URL detected in a sign-in session and already opened for the user. */
  openedAuthUrl?: string
  exitCode: number | null
}

export type InstallTarget = { provider: ProviderId; agent?: string }

export type ProviderLoginTerminalTarget = {
  provider?: ProviderId
  displayName: string
  installKey: string
  operation?: 'install' | 'login'
  source?: 'providers' | 'pull-requests'
}

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

export function updateKey(provider: ProviderId): string {
  return `update:${provider}`
}

export function beginUpdate(transport: Transport, provider: ProviderId): Promise<void> {
  return begin(transport, updateKey(provider), () =>
    transport.request('providers.update', { provider, columns: 100, rows: 30 }),
  )
}

const LOG_CAP = 200_000

const installs = new Map<string, InstallState>()
const starts = new Map<string, Promise<void>>()
const cancellations = new Map<string, Promise<void>>()
const reconcilers = new Map<string, () => Promise<void>>()
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

/** Stop the owned PTY before releasing the sign-in session. */
export function cancelInstall(transport: Transport, key: string): Promise<void> {
  const pending = cancellations.get(key)
  if (pending) return pending
  const operation = (async () => {
    await starts.get(key)
    const state = installs.get(key)
    if (state?.phase !== 'running') return
    installs.set(key, { ...state, canceling: true })
    notify()
    try {
      await transport.request('terminal.close', { terminalId: state.terminalId })
      const current = installs.get(key)
      if (current?.terminalId !== state.terminalId) return
      detachTransportListeners(key)
      installs.set(key, { ...current, phase: 'canceled', canceling: false })
      notify()
    } catch (cause) {
      const current = installs.get(key)
      if (current?.terminalId === state.terminalId && current.phase === 'running') {
        installs.set(key, { ...current, canceling: false })
        notify()
      }
      throw cause
    }
  })()
  cancellations.set(key, operation)
  void operation
    .finally(() => {
      if (cancellations.get(key) === operation) cancellations.delete(key)
    })
    .catch(() => undefined)
  return operation
}

/** Test isolation only: module state must not leak between test cases. */
export function resetInstalls(): void {
  for (const key of transportListeners.keys()) detachTransportListeners(key)
  installs.clear()
  starts.clear()
  cancellations.clear()
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
  reconcilers.delete(key)
}

/**
 * Start (or reattach to) a background install. The server keys the terminal
 * by target, so calling this twice while one is running attaches to the same
 * session rather than installing twice.
 */
export async function beginInstall(transport: Transport, target: InstallTarget): Promise<void> {
  return begin(transport, installKey(target), () =>
    transport.request('providers.install', {
      provider: target.provider,
      ...(target.agent ? { agent: target.agent } : {}),
      columns: 100,
      rows: 30,
    }),
  )
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
  return begin(
    transport,
    loginKey(target),
    () =>
      transport.request('providers.launch', {
        provider: target.provider,
        ...(target.agent ? { agent: target.agent } : {}),
        columns: LOGIN_COLUMNS,
        rows: 30,
      }),
    openUrl,
  )
}

export type GitHubSetupAction = 'install' | 'login'

export function githubSetupKey(action: GitHubSetupAction): string {
  return `pull-requests:github:${action}`
}

/** Run GitHub CLI setup in the same attachable terminal store as provider setup. */
export async function beginGitHubSetup(
  transport: Transport,
  action: GitHubSetupAction,
): Promise<void> {
  return begin(transport, githubSetupKey(action), () =>
    transport.request('pullRequests.setup', {
      action,
      columns: action === 'login' ? LOGIN_COLUMNS : 100,
      rows: 30,
    }),
  )
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
  if (!match?.[1]) return undefined
  const url = new URL(match[1])
  const userCode = url.searchParams.get('user_code')
  const codePattern = url.hostname === 'accounts.x.ai' ? /^[A-Z0-9]{4}-[A-Z0-9]{4}/ : undefined
  const exactCode = codePattern?.exec(userCode ?? '')?.[0]
  if (userCode && exactCode && userCode !== exactCode) url.searchParams.set('user_code', exactCode)
  return url.toString()
}

export function signedInEmail(log: string): string | undefined {
  return /\bsigned in as\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i.exec(
    log.replace(ANSI, ''),
  )?.[1]
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

function begin(
  transport: Transport,
  key: string,
  openTerminal: () => Promise<{ terminalId: string }>,
  openUrl?: (url: string) => void,
): Promise<void> {
  const canceling = cancellations.get(key)
  if (canceling) return canceling.then(() => begin(transport, key, openTerminal, openUrl))
  const starting = starts.get(key)
  if (starting) return starting
  const operation = attachJob(transport, key, openTerminal, openUrl)
  starts.set(key, operation)
  void operation
    .finally(() => {
      if (starts.get(key) === operation) starts.delete(key)
    })
    .catch(() => undefined)
  return operation
}

async function attachJob(
  transport: Transport,
  key: string,
  openTerminal: () => Promise<{ terminalId: string }>,
  openUrl?: (url: string) => void,
): Promise<void> {
  const existing = installs.get(key)
  if (existing?.phase === 'running') return reconcilers.get(key)?.()

  // A fast updater can exit before the RPC response names its terminal.
  // Subscribe first, then replay only that terminal's bounded early output.
  const earlyOutput = new Map<string, { data: string; outputOffset: number }>()
  const earlyExit = new Map<string, DataOf<'terminal.exit'>>()
  let buffered = 0
  const stopEarlyOutput = transport.on('terminal.output', (event) => {
    const previous = earlyOutput.get(event.terminalId)
    if (!previous && earlyOutput.size >= 100) return
    const end = (previous?.outputOffset ?? 0) + (previous?.data.length ?? 0)
    const start = event.outputOffset ?? end
    if (start + event.data.length <= end) return
    const combined =
      start > end ? event.data : (previous?.data ?? '') + event.data.slice(Math.max(0, end - start))
    const data = combined.slice(-LOG_CAP)
    const outputOffset = start + event.data.length - data.length
    buffered += data.length - (previous?.data.length ?? 0)
    earlyOutput.set(event.terminalId, { data, outputOffset })
    while (buffered > LOG_CAP && earlyOutput.size > 1) {
      const first = earlyOutput.keys().next().value!
      buffered -= earlyOutput.get(first)!.data.length
      earlyOutput.delete(first)
    }
  })
  const stopEarlyExit = transport.on('terminal.exit', (event) => {
    if (earlyExit.size < 100) earlyExit.set(event.terminalId, event)
  })
  let terminalId: string
  try {
    ;({ terminalId } = await openTerminal())
  } finally {
    stopEarlyOutput()
    stopEarlyExit()
  }

  const state: InstallState = {
    phase: 'running',
    canceling: cancellations.has(key),
    terminalId,
    log: '',
    logOffset: 0,
    lastLine: '',
    exitCode: null,
  }
  installs.set(key, state)
  notify()

  // A retry replaces the session; the old session's listeners go with it.
  detachTransportListeners(key)
  const onOutput = (event: DataOf<'terminal.output'>) => {
    const current = installs.get(key)
    if (!current || current.terminalId !== terminalId || event.terminalId !== terminalId) return
    const end = current.logOffset + current.log.length
    const start = event.outputOffset ?? end
    if (start + event.data.length <= end) return
    const combined =
      start > end ? event.data : current.log + event.data.slice(Math.max(0, end - start))
    const log = combined.slice(-LOG_CAP)
    const logOffset = start + event.data.length - log.length
    let openedAuthUrl = current.openedAuthUrl
    if (openUrl && !openedAuthUrl && !cancellations.has(key)) {
      const url = firstAuthUrl(log)
      if (url) {
        openedAuthUrl = url
        openUrl(url)
      }
    }
    installs.set(key, {
      ...current,
      log,
      logOffset,
      lastLine: lastPrintableLine(log),
      ...(openedAuthUrl ? { openedAuthUrl } : {}),
    })
    notify()
  }
  const onExit = (event: DataOf<'terminal.exit'>, recoverOutput = true) => {
    if (event.terminalId !== terminalId) return
    detachTransportListeners(key)
    const current = installs.get(key)
    if (!current) return
    installs.set(key, {
      ...current,
      phase: current.canceling ? 'canceled' : event.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: event.exitCode,
    })
    notify()
    if (recoverOutput) void reconcile(true)
  }
  const offOutput = transport.on('terminal.output', onOutput)
  const offExit = transport.on('terminal.exit', onExit)
  let revision = 0
  const reconcile = async (allowFinished = false) => {
    const mine = ++revision
    try {
      const status = await transport.request('terminal.status', { terminalId })
      const current = installs.get(key)
      if (
        mine !== revision ||
        current?.terminalId !== terminalId ||
        (current.phase !== 'running' && !allowFinished)
      )
        return
      if (status.status === 'unknown') {
        if (allowFinished) return
        installs.set(key, {
          ...current,
          phase: 'failed',
          lastLine: 'This terminal is no longer available. Start again.',
        })
        detachTransportListeners(key)
        notify()
        return
      }
      // A live push can arrive while this read is in flight. Merge the snapshot
      // and its newer suffix using server positions, so no text is repeated.
      const snapshotEnd = status.outputOffset + status.output.length
      const currentEnd = current.logOffset + current.log.length
      if (snapshotEnd >= current.logOffset) {
        const suffix =
          currentEnd > snapshotEnd ? current.log.slice(snapshotEnd - current.logOffset) : ''
        const combined = status.output + suffix
        const log = combined.slice(-LOG_CAP)
        const openedAuthUrl =
          current.openedAuthUrl ??
          (openUrl && !cancellations.has(key) ? firstAuthUrl(log) : undefined)
        installs.set(key, {
          ...current,
          log,
          logOffset: Math.max(snapshotEnd, currentEnd) - log.length,
          lastLine: lastPrintableLine(log),
          ...(openedAuthUrl ? { openedAuthUrl } : {}),
        })
        if (openedAuthUrl && !current.openedAuthUrl) openUrl?.(openedAuthUrl)
        notify()
      }
      if (status.status === 'exited') onExit({ terminalId, exitCode: status.exitCode }, false)
    } catch {
      // Keep ownership during an outage. The next open or gap retries only
      // this read; it never launches a second installer or login process.
    }
  }
  const offState = transport.onState((connection) => {
    revision += 1
    if (connection === 'open') void reconcile()
  })
  const offGap = transport.onSequenceGap(() => void reconcile())
  transportListeners.set(key, [
    offOutput,
    offExit,
    offState,
    offGap,
    () => {
      revision += 1
    },
  ])
  reconcilers.set(key, reconcile)
  const output = earlyOutput.get(terminalId)
  if (output) onOutput({ terminalId, ...output })
  const exited = earlyExit.get(terminalId)
  if (exited) onExit(exited)
  else void reconcile()
}

function notify(): void {
  for (const listener of listeners) listener()
}

// CSI sequences, OSC sequences (title updates and the like), then any stray
// control byte that is not a newline. Enough to turn pty output into a note.
const ANSI =
  // oxlint-disable-next-line no-control-regex, no-useless-escape -- ANSI parsing requires control bytes.
  /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g

export function lastPrintableLine(log: string): string {
  const lines = log.replace(ANSI, '').split(/\r\n|\n|\r/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (line) return line
  }
  return ''
}
