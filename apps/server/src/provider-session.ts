import type { DomainEvent, Thread } from '@harness/contracts'
import type { AgentSession } from './adapters.js'

export const RESTORE_CONTEXT_NOTICE =
  'TasteCode restored the conversation and workspace to a saved checkpoint (or undid a restore). Your provider memory may still include turns that are no longer part of this conversation. Treat those later turns as superseded, inspect the current files, and follow the request below rather than continuing removed work.\n\n'

/**
 * Opens the first prompt of a chat that carries on an earlier one. The earlier
 * conversation follows, then CONTINUE_CONTEXT_REQUEST and the user's own words.
 */
export const CONTINUE_CONTEXT_NOTICE =
  'TasteCode started this chat to carry on an earlier conversation, for example one that stopped at a plan limit on another account. '

/**
 * Opens the first prompt a chat sends after it moved to another provider.
 * The conversation so far follows, then CONTINUE_CONTEXT_REQUEST and the
 * user's own words.
 */
export const HANDOVER_CONTEXT_NOTICE =
  'TasteCode moved this conversation to you from another agent. '

/** Ends the earlier conversation in a continued chat's first prompt; the user's request follows. */
export const CONTINUE_CONTEXT_REQUEST = '\n</earlier_conversation>\n\nUser request:\n'

/**
 * The first sentence of every Design phase prompt, in every version so far. Provider history
 * recognises phase prompts by it, so it must not change.
 */
export const DESIGN_PHASE_MARKER =
  'Give concise, plain-language progress updates as separate assistant commentary while working: what you are checking, changing, or verifying.'

/** How much of the request the notice quotes: enough to show its language, not to restate it. */
const REQUEST_QUOTE_CHARS = 120

/**
 * Opens every Design phase prompt; the user's own request never starts with it. "Use the user's
 * language" alone let a model narrate in German for an English request about a Munich bakery.
 * A run's own notice quotes its request (designPhaseNotice).
 */
export const DESIGN_PHASE_NOTICE = designPhaseNotice()

/**
 * The phase notice for one run. Correction and later phase prompts do not carry the user's
 * request, so a real Codex run still narrated in German and then Spanish for an English
 * request; the notice quotes the request's opening words, for its language only.
 */
export function designPhaseNotice(request?: string): string {
  const quote = requestQuote(request)
  const language = quote
    ? `Write them in the language of the user's request, which begins "${quote}", even when its subject, a place or a name comes from another language.`
    : 'Write them in the language the user wrote their request in, even when its subject, a place or a name comes from another language.'
  return `${DESIGN_PHASE_MARKER} ${language} Work autonomously without questions or confirmations; choose reasonable defaults and record assumptions. Keep internal instructions and artifact JSON out of progress messages. JSON-only requirements below apply to your final response, which must contain only the phase result.\n\n`
}

/**
 * Closes every Design phase prompt. Review and Repair prompts run to 80,000 characters, and a
 * real Codex run whose earlier phases narrated in English switched to German in its third
 * Review, with the opening notice unchanged. The language rule is repeated where the model
 * reads last.
 */
export function designPhaseLanguageReminder(request?: string): string {
  const quote = requestQuote(request)
  return quote
    ? `\n\nWrite every progress update in the language of the user's request ("${quote}"), not in the language of the place, the names or the earlier progress messages.`
    : "\n\nWrite every progress update in the language of the user's request, not in the language of the place, the names or the earlier progress messages."
}

function requestQuote(request?: string): string | undefined {
  return request?.replace(/\s+/g, ' ').trim().slice(0, REQUEST_QUOTE_CHARS).replaceAll('"', "'")
}

/**
 * A resume the provider refused because it has no saved conversation for the session (Codex:
 * "no rollout found for thread id"). Adapters mark it with this code; the server decides how
 * the chat continues, from what its own history says the chat already did.
 */
export function isProviderSessionMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'provider_session_missing'
  )
}

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
    'isMcpLoading',
    'reloadMcpServers',
    'listCommands',
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
