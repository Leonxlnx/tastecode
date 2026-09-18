import type { DomainEvent, Thread } from '@harness/contracts'
import type { AgentSession } from './adapters.js'

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
