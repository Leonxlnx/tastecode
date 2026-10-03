import type { DomainEvent, Thread } from '@harness/contracts'
import type { AgentSession } from './adapters.js'

export const RESTORE_CONTEXT_NOTICE =
  'TasteCode restored the conversation and workspace to a saved checkpoint (or undid a restore). Your provider memory may still include turns that are no longer part of this conversation. Treat those later turns as superseded, inspect the current files, and follow the request below rather than continuing removed work.\n\n'

/** Preserve the local identity while resuming an imported provider session. */
export function mapProviderSession(
  threadId: string,
  result: { thread: Thread; session: AgentSession },
) {
  const nativeId = result.thread.id
  if (threadId === nativeId) return result
  const withThreadId = new Set([
    'sendTurn',
    'steer',
    'interrupt',
    'listMcpServers',
    'reloadMcpServers',
  ])
  const session = new Proxy(result.session, {
    get(target, key) {
      const member = Reflect.get(target, key, target) as unknown
      if (typeof member !== 'function') return member
      if (key === 'on')
        return (event: 'event' | 'log', listener: (value: never) => void) => {
          if (event === 'event')
            target.on('event', (value) => listener(mapEventThread(value, threadId) as never))
          else target.on('log', (line) => listener(line as never))
        }
      if (withThreadId.has(String(key)))
        return (_id: string, ...args: unknown[]) =>
          Reflect.apply(member, target, [nativeId, ...args])
      if (key === 'startMcpOAuth')
        return (serverId: string) => target.startMcpOAuth!(serverId, nativeId)
      return member.bind(target)
    },
  })
  return { thread: { ...result.thread, id: threadId }, session }
}

function mapEventThread(event: DomainEvent, id: string): DomainEvent {
  if (event.type === 'thread.started') return { ...event, thread: { ...event.thread, id } }
  if (event.type === 'turn.started') return { ...event, turn: { ...event.turn, threadId: id } }
  if (event.type === 'thread.error') return { ...event, threadId: id }
  return event
}

/**
 * A session failed to start and then could not confirm that its process exited.
 * The caller must keep the session for a later stop, and its checkout until then.
 */
export class StartupCleanupError extends Error {
  constructor(
    readonly startError: unknown,
    readonly cleanupError: unknown,
    readonly session: { dispose(): void | Promise<void> },
  ) {
    super(startError instanceof Error ? startError.message : String(startError), {
      cause: startError,
    })
    this.name = 'StartupCleanupError'
  }
}
