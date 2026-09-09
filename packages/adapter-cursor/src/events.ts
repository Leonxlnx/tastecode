import type { DomainEvent, Item } from '@harness/contracts'
import { JsonRpcValueSchema, type JsonRpcValue } from '@harness/proc'
import { z } from 'zod'

const JsonObjectSchema = z.record(z.string(), JsonRpcValueSchema)

export const CursorEventSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  duration_ms: z.number().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  call_id: z.string().optional(),
  message: z
    .object({
      content: z
        .array(z.object({ type: z.string().optional(), text: z.string().optional() }))
        .optional(),
    })
    .optional(),
  tool_call: z
    .record(
      z.string(),
      z.object({ args: JsonObjectSchema.optional(), result: JsonRpcValueSchema.optional() }),
    )
    .optional(),
})

export type CursorEvent = z.infer<typeof CursorEventSchema>

export class CursorEventMapper {
  readonly #turnId: string
  readonly #messageId: string
  #messageStarted = false
  #message = ''
  readonly #tools = new Map<string, Item>()

  constructor(turnId: string) {
    this.#turnId = turnId
    this.#messageId = `${turnId}-message`
  }

  translate(event: CursorEvent): DomainEvent[] {
    if (event.type === 'assistant') return this.#assistant(event)
    if (event.type === 'tool_call') return this.#tool(event)
    if (event.type === 'result') return this.#result(event)
    return []
  }

  finish(): DomainEvent[] {
    const events: DomainEvent[] = []
    if (this.#messageStarted) {
      events.push({
        type: 'item.completed',
        item: {
          id: this.#messageId,
          turnId: this.#turnId,
          type: 'message',
          role: 'assistant',
          status: 'failed',
          text: this.#message,
          createdAt: Date.now(),
        },
      })
    }
    for (const item of this.#tools.values()) {
      events.push({ type: 'item.completed', item: { ...item, status: 'failed' } })
    }
    this.#tools.clear()
    return events
  }

  #assistant(event: CursorEvent): DomainEvent[] {
    const delta = event.message?.content
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
    if (!delta) return []
    const events: DomainEvent[] = []
    if (!this.#messageStarted) {
      this.#messageStarted = true
      events.push({
        type: 'item.started',
        item: {
          id: this.#messageId,
          turnId: this.#turnId,
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: '',
          createdAt: Date.now(),
        },
      })
    }
    this.#message += delta
    events.push({
      type: 'item.delta',
      turnId: this.#turnId,
      itemId: this.#messageId,
      textDelta: delta,
    })
    return events
  }

  #tool(event: CursorEvent): DomainEvent[] {
    if (!event.call_id || !event.tool_call) return []
    const [name, call] = Object.entries(event.tool_call)[0] ?? []
    if (!name || !call) return []
    const id = `${this.#turnId}-${event.call_id}`
    if (event.subtype === 'started') {
      const item = toolItem(id, this.#turnId, name, call.args ?? {})
      this.#tools.set(id, item)
      return [{ type: 'item.started', item }]
    }
    if (event.subtype === 'completed') {
      const item = this.#tools.get(id) ?? toolItem(id, this.#turnId, name, call.args ?? {})
      this.#tools.delete(id)
      return [{ type: 'item.completed', item: { ...item, status: 'completed' } }]
    }
    return []
  }

  #result(event: CursorEvent): DomainEvent[] {
    const events: DomainEvent[] = []
    if (this.#messageStarted) {
      events.push({
        type: 'item.completed',
        item: {
          id: this.#messageId,
          turnId: this.#turnId,
          type: 'message',
          role: 'assistant',
          status: event.is_error ? 'failed' : 'completed',
          text: this.#message,
          createdAt: Date.now(),
          ...(!(event.duration_ms === undefined)
            ? {
                durationMs: event.duration_ms,
              }
            : {}),
        },
      })
    }
    for (const item of this.#tools.values()) {
      events.push({ type: 'item.completed', item: { ...item, status: 'failed' } })
    }
    this.#tools.clear()
    events.push({
      type: 'turn.completed',
      turnId: this.#turnId,
      status: event.is_error ? 'failed' : 'completed',
    })
    return events
  }
}

function toolItem(
  id: string,
  turnId: string,
  name: string,
  args: Record<string, JsonRpcValue>,
): Item {
  const base = { id, turnId, status: 'started' as const, createdAt: Date.now() }
  if (/shell|terminal|command/i.test(name)) {
    return { ...base, type: 'command', command: string(args['command']) || name }
  }
  if (/write|edit|delete|move/i.test(name)) {
    return {
      ...base,
      type: 'file_change',
      path: string(args['path']) || string(args['file_path']) || string(args['filePath']) || name,
    }
  }
  return { ...base, type: 'tool_call', text: name }
}

function string(value: JsonRpcValue | undefined): string {
  const parsed = z.string().safeParse(value)
  return parsed.success ? parsed.data : ''
}
