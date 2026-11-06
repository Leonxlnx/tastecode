import type { BrowserCommand, ParamsOf } from '@harness/contracts'
import { canCapturePreview, isDesktop } from './bridge.js'

/** The chats whose own browser tab this window shows, one entry per workspace panel. */
const shown = new Map<symbol, string>()

/**
 * What this window tells the server it can do. The desktop app runs agent browser commands on a
 * chat's own tab; the server sends them only for the chats listed here.
 */
export function clientCapabilities(): ParamsOf<'client.capabilities'> {
  return {
    previewCapture: canCapturePreview,
    ...(isDesktop
      ? { browserTools: true, browserThreads: [...new Set(shown.values())].slice(0, 16) }
      : {}),
  }
}

/**
 * A workspace panel shows this chat; the returned function says it stopped. Each change is sent
 * at once, on a chat switch, never per streamed event.
 */
export function showBrowserThread(
  send: (capabilities: ParamsOf<'client.capabilities'>) => Promise<unknown>,
  threadId: string,
): () => void {
  const key = Symbol(threadId)
  shown.set(key, threadId)
  void send(clientCapabilities()).catch(() => undefined)
  return () => {
    shown.delete(key)
    void send(clientCapabilities()).catch(() => undefined)
  }
}

/** What the window heard for the agent's browser, for the panel that runs it. */
export type AgentBrowserEvent =
  { kind: 'command'; command: BrowserCommand } | { kind: 'cancel'; commandId: string }

/**
 * How long a waiting event may still be handed on: the server's time for one command. Past it the
 * server has already told the agent the command timed out, so running it would surprise everyone.
 */
export const AGENT_BROWSER_EVENT_TTL_MS = 30_000

/** Events that arrived before the workspace panel had loaded; a few at most, with their time. */
const waiting: Array<{ event: AgentBrowserEvent; at: number }> = []
let receiver: ((event: AgentBrowserEvent) => void) | undefined

/**
 * The app hears browser pushes even while the workspace panel has not loaded, and hands them to
 * the panel here: at once while it listens, or when it starts listening, if still fresh.
 */
export function deliverAgentBrowserEvent(event: AgentBrowserEvent, now = Date.now()): void {
  if (receiver) receiver(event)
  else if (waiting.push({ event, at: now }) > 8) waiting.shift()
}

export function receiveAgentBrowserEvents(
  next: (event: AgentBrowserEvent) => void,
  now = Date.now(),
): () => void {
  receiver = next
  for (const { event, at } of waiting.splice(0))
    if (now - at < AGENT_BROWSER_EVENT_TTL_MS) next(event)
  return () => {
    if (receiver === next) receiver = undefined
  }
}

/** Another chat is on screen: what waited for the last one is not this one's. */
export function clearAgentBrowserEvents(): void {
  waiting.length = 0
}
