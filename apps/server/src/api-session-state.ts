import type { ApiAgentSession, ApiSessionState } from '@harness/adapter-api'
import { ThreadSchema } from '@harness/contracts'
import { z } from 'zod'
import type { AgentSession } from './adapters.js'

const ApiMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string(),
      toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.json() })),
      transportState: z.json().optional(),
    })
    .transform(({ transportState, ...message }) => ({
      ...message,
      ...(transportState === undefined ? {} : { transportState }),
    })),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: z.string(),
    isError: z.boolean(),
  }),
])

export const ApiRuntimeStateSchema = z.object({
  version: z.literal(1),
  model: z.string().min(1),
  state: z.object({
    thread: ThreadSchema,
    messages: z.array(ApiMessageSchema),
    turnCounter: z.number().int().nonnegative(),
  }),
})

/** Keep the credential out of durable state even when a prompt or tool echoed it. */
export function persistentApiSession(
  session: ApiAgentSession,
  model: string,
  apiKey: string,
): AgentSession {
  return new Proxy(session, {
    get(target, key) {
      if (key === 'snapshot') {
        return () => {
          const state = target.snapshot()
          return ApiRuntimeStateSchema.parse({
            version: 1,
            model,
            state: apiKey ? redactState(state, apiKey) : state,
          })
        }
      }
      const member = Reflect.get(target, key, target) as unknown
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
}

const REDACTED = '[redacted]'

// Only free text is rewritten. Ids, roles and numbers stay as they are, because
// local servers are often given placeholder keys such as "1" that also occur there.
function redactState(state: ApiSessionState, secret: string): ApiSessionState {
  // A resumed thread is saved again; leave earlier markers alone so a key that
  // occurs inside "[redacted]" (such as "e") does not grow the text every save.
  const text = (value: string) =>
    value
      .split(REDACTED)
      .map((part) => part.replaceAll(secret, REDACTED))
      .join(REDACTED)
  const json = <T>(value: T): T => {
    if (typeof value === 'string') return text(value) as T
    if (Array.isArray(value)) return value.map(json) as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [text(key), json(item)]),
      ) as T
    }
    return value
  }
  const holdsSecret = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(secret)
    if (Array.isArray(value)) return value.some(holdsSecret)
    if (value && typeof value === 'object') {
      return Object.entries(value).some(([key, item]) => key.includes(secret) || holdsSecret(item))
    }
    return false
  }
  return {
    ...state,
    thread:
      state.thread.title === undefined
        ? state.thread
        : { ...state.thread, title: text(state.thread.title) },
    messages: state.messages.map((message) => {
      if (message.role !== 'assistant') return { ...message, content: text(message.content) }
      // Provider replay state is opaque: its ids, types and signatures must
      // match the rest of the conversation exactly. Rather than rewrite it,
      // drop it; the transports rebuild the message from content and tool calls.
      const { transportState, ...rest } = message
      return {
        ...rest,
        content: text(message.content),
        toolCalls: message.toolCalls.map((call) => ({ ...call, input: json(call.input) })),
        ...(transportState === undefined || holdsSecret(transportState) ? {} : { transportState }),
      }
    }),
  }
}
