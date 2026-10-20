import { useEffect } from 'react'
import { installAppUpdate } from './bridge.js'
import type { Transport } from './transport.js'
import type { Project, Session } from './ui/Sidebar.js'

/**
 * Installing an app update quits TasteCode, and quitting cuts off every chat
 * that is still working. So the install waits: when chats are running it
 * starts by itself once the last one ends, and Install now stops them first.
 *
 * Which chats run is the server's state. The sidebar status it pushes is the
 * live count (it changes on status changes, never per streamed delta), and
 * the server's own chat list has the last word before anything installs,
 * because a queued prompt starts the next turn a moment after the last one
 * ended. Nothing here looks at providers, so every agent and API connection
 * is treated the same.
 */
export type AppUpdateInstallState =
  | { phase: 'idle'; failed?: boolean }
  /** Asking the server whether chats are running before a click installs. */
  | { phase: 'checking' }
  /** Installs by itself once `running` reaches zero. */
  | { phase: 'waiting'; running: number }
  /** Install now: stopping the running chats, then installing. */
  | { phase: 'stopping'; running: number }
  | { phase: 'installing' }

export type AppUpdateInstallGate = {
  /** How many chats the server still runs, or holds queued prompts for. */
  runningChats: () => Promise<number>
  /** Ends the running turns; queued prompts stay for after the restart. */
  stopRunningChats: () => Promise<void>
}

/** Inside a turn (also when it waits on an approval or a question), or about to start one. */
const RUNNING = new Set<Session['status']>(['starting', 'working', 'queued', 'approval', 'input'])

/** A chat that ends sends its next queued prompt within a moment; wait that long first. */
export const INSTALL_SETTLE_MS = 750
const MAX_RECHECK_MS = 8_000
/** As long as the server's Stop all gives an agent; after that the restart ends its turn. */
const STOP_TURNS_TIMEOUT_MS = 5_000

let state: AppUpdateInstallState = { phase: 'idle' }
let live = 0
let gate: AppUpdateInstallGate | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let recheck = INSTALL_SETTLE_MS
const listeners = new Set<() => void>()

function publish(next: AppUpdateInstallState) {
  state = next
  for (const listener of listeners) listener()
}

function clearTimer() {
  if (timer) clearTimeout(timer)
  timer = undefined
}

export function appUpdateInstallState(): AppUpdateInstallState {
  return state
}

export function subscribeAppUpdateInstall(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function chatCount(running: number): string {
  return `${running} ${running === 1 ? 'chat' : 'chats'}`
}

export function waitingLabel(running: number): string {
  return `Installs when ${chatCount(running)} ${running === 1 ? 'finishes' : 'finish'}`
}

const projectCounts = new WeakMap<Project, string[]>()

function runningIds(project: Project): string[] {
  const cached = projectCounts.get(project)
  if (cached) return cached
  const ids = project.sessions
    .filter((session) => RUNNING.has(session.status))
    .map((session) => session.id)
  projectCounts.set(project, ids)
  return ids
}

/** Running chats in the sidebar. A status change replaces only its own project. */
export function runningChatCount(projects: readonly Project[]): number {
  const ids = new Set<string>()
  for (const project of projects) for (const id of runningIds(project)) ids.add(id)
  return ids.size
}

/** Running chats in the server's own list; `running` is its turn state. */
export function serverRunningChatCount(
  projects: ReadonlyArray<{
    sessions: ReadonlyArray<{
      id: string
      running: boolean
      status?: Session['status'] | undefined
    }>
  }>,
): number {
  const ids = new Set<string>()
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.running || (session.status && RUNNING.has(session.status))) ids.add(session.id)
    }
  }
  return ids.size
}

export function setAppUpdateInstallGate(next: AppUpdateInstallGate | undefined): void {
  gate = next
}

/** Undefined when the server could not say; the sidebar count is all there is then. */
async function serverRunning(): Promise<number | undefined> {
  if (!gate) return undefined
  try {
    return await gate.runningChats()
  } catch {
    return undefined
  }
}

async function install(): Promise<void> {
  clearTimer()
  recheck = INSTALL_SETTLE_MS
  publish({ phase: 'installing' })
  let installed = false
  try {
    installed = await installAppUpdate()
  } catch {
    installed = false
  }
  // A successful install quits the app; until then this window keeps the spinner.
  if (!installed) publish({ phase: 'idle', failed: true })
}

function scheduleSettle() {
  if (timer) return
  timer = setTimeout(() => {
    timer = undefined
    void settle()
  }, recheck)
}

async function settle(): Promise<void> {
  if (state.phase !== 'waiting' || live > 0) return
  const running = await serverRunning()
  if (state.phase !== 'waiting' || live > 0) return
  if (!running) {
    await install()
    return
  }
  // The server still runs a chat the sidebar does not show yet (a queued
  // prompt starting); look again until its status arrives.
  if (state.running !== running) publish({ phase: 'waiting', running })
  recheck = Math.min(recheck * 2, MAX_RECHECK_MS)
  scheduleSettle()
}

/** The sidebar's running count, after every status change. */
export function reportRunningChats(count: number): void {
  live = count
  if (state.phase !== 'waiting') return
  if (count > 0) {
    clearTimer()
    recheck = INSTALL_SETTLE_MS
    if (state.running !== count) publish({ phase: 'waiting', running: count })
    return
  }
  scheduleSettle()
}

/** Restart to update: installs now when no chat runs, otherwise waits for them. */
export async function requestAppUpdateInstall(): Promise<void> {
  if (state.phase !== 'idle') return
  if (live > 0) {
    publish({ phase: 'waiting', running: live })
    return
  }
  if (!gate) {
    await install()
    return
  }
  publish({ phase: 'checking' })
  const running = await serverRunning()
  // Install later or a second click may have moved on meanwhile.
  if (appUpdateInstallState().phase !== 'checking') return
  if (!running) {
    await install()
    return
  }
  publish({ phase: 'waiting', running: Math.max(running, live) })
  if (live === 0) scheduleSettle()
}

/** Install now, confirmed: stops the running chats, then installs. */
export async function stopChatsAndInstall(): Promise<void> {
  if (state.phase !== 'waiting') return
  clearTimer()
  publish({ phase: 'stopping', running: state.running })
  try {
    await gate?.stopRunningChats()
  } catch {
    // Quitting ends those chats too; the user asked for the install now.
  }
  await install()
}

/** Install later: stop waiting and forget a failed install. */
export function cancelAppUpdateInstall(): void {
  clearTimer()
  recheck = INSTALL_SETTLE_MS
  if (state.phase === 'idle' && !state.failed) return
  publish({ phase: 'idle' })
}

/**
 * Install now ends the running turns and keeps every queued prompt. Queued
 * prompts are saved and come back after the restart, so the update must not
 * delete them, which the server's Stop all would do in every chat.
 *
 * A chat is stopped the way its own Stop button stops it, unless it also
 * holds queued prompts: when a turn ends the server sends the next queued
 * prompt at once, and the restart would cut that one off. The restart ends
 * such a chat's turn instead, and its queue stays as it is.
 */
function stopRunningTurns(transport: Pick<Transport, 'request'>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = (async () => {
    const { projects } = await transport.request('projects.list', {})
    const running = new Set<string>()
    for (const project of projects) {
      for (const session of project.sessions) if (session.running) running.add(session.id)
    }
    await Promise.allSettled(
      [...running].map(async (threadId) => {
        const { items } = await transport.request('thread.queue', { threadId })
        if (items.length === 0) await transport.request('thread.interrupt', { threadId })
      }),
    )
  })().finally(() => clearTimeout(timer))
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STOP_TURNS_TIMEOUT_MS)
  })
  return Promise.race([stopped, late])
}

/**
 * Feeds the install gate from the app: the sidebar's running count after
 * each status change, and the server for the final word and for stopping.
 * Nothing is counted before the chat list has loaded.
 */
export function useAppUpdateInstallGate(
  transport: Pick<Transport, 'request'>,
  projects: readonly Project[],
  loaded: boolean,
): void {
  useEffect(() => {
    setAppUpdateInstallGate({
      runningChats: async () =>
        serverRunningChatCount((await transport.request('projects.list', {})).projects),
      stopRunningChats: () => stopRunningTurns(transport),
    })
    return () => setAppUpdateInstallGate(undefined)
  }, [transport])
  useEffect(() => {
    if (loaded) reportRunningChats(runningChatCount(projects))
  }, [projects, loaded])
}

/** Tests only: back to a fresh window. */
export function resetAppUpdateInstallForTests(): void {
  clearTimer()
  recheck = INSTALL_SETTLE_MS
  live = 0
  gate = undefined
  state = { phase: 'idle' }
}
