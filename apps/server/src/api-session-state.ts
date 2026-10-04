import type { ApiAgentSession } from '@harness/adapter-api'
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
          const encoded = JSON.stringify({ version: 1, model, state: target.snapshot() })
          const secret = JSON.stringify(apiKey).slice(1, -1)
          return ApiRuntimeStateSchema.parse(
            JSON.parse(secret ? encoded.replaceAll(secret, '[redacted]') : encoded),
          )
        }
      }
      const member = Reflect.get(target, key, target) as unknown
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
}
