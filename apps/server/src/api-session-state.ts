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

// Only free text is rewritten. Ids, roles and numbers stay as they are, because
// local servers are often given placeholder keys such as "1" that also occur there.
function redactState(state: ApiSessionState, secret: string): ApiSessionState {
  const text = (value: string) => value.replaceAll(secret, '[redacted]')
  const json = <T>(value: T): T => {
    if (typeof value === 'string') return text(value) as T
    if (Array.isArray(value)) return value.map(json) as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)])) as T
    }
    return value
  }
  return {
    ...state,
    thread:
      state.thread.title === undefined
        ? state.thread
        : { ...state.thread, title: text(state.thread.title) },
    messages: state.messages.map((message) =>
      message.role === 'assistant'
        ? {
            ...message,
            content: text(message.content),
            toolCalls: message.toolCalls.map((call) => ({ ...call, input: json(call.input) })),
            ...(message.transportState === undefined
              ? {}
              : { transportState: json(message.transportState) }),
          }
        : { ...message, content: text(message.content) },
    ),
  }
}
