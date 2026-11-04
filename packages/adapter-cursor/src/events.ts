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
  /** The message the last `assistant` event opened, until something closes it. */
  #message: { id: string; text: string } | undefined
  #messageCount = 0
  readonly #tools = new Map<string, Item>()

  constructor(turnId: string) {
    this.#turnId = turnId
  }

  translate(event: CursorEvent): DomainEvent[] {
    if (event.type === 'assistant') return this.#assistant(event)
    if (event.type === 'tool_call') return this.#tool(event)
    if (event.type === 'result') return this.#result(event)
    return []
  }

  finish(): DomainEvent[] {
    const events = this.#closeMessage('failed')
    for (const item of this.#tools.values()) {
      events.push({ type: 'item.completed', item: { ...item, status: 'failed' } })
    }
    this.#tools.clear()
    return events
  }

  /**
   * Without --stream-partial-output, cursor-agent buffers the model's text and
   * prints it as one `assistant` event before each tool call, retry,
   * interaction query and the `result`. Every event is a whole segment, so
   * each gets a message of its own and text around tool calls stays in order.
   */
  #assistant(event: CursorEvent): DomainEvent[] {
    const text = event.message?.content
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
    if (!text) return []
    const events = this.#closeMessage('completed')
    this.#messageCount += 1
    // The first message keeps the id a single-message turn always had.
    const id =
      this.#messageCount === 1
        ? `${this.#turnId}-message`
        : `${this.#turnId}-message-${this.#messageCount}`
    this.#message = { id, text }
    events.push(
      {
        type: 'item.started',
        item: {
          id,
          turnId: this.#turnId,
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: '',
          createdAt: Date.now(),
        },
      },
      { type: 'item.delta', turnId: this.#turnId, itemId: id, textDelta: text },
    )
    return events
  }

  #tool(event: CursorEvent): DomainEvent[] {
    if (!event.call_id || !event.tool_call) return []
    const [name, call] = Object.entries(event.tool_call)[0] ?? []
    if (!name || !call) return []
    const id = `${this.#turnId}-${event.call_id}`
    // The text before a tool call is complete; later text is a new message.
    const events = this.#closeMessage('completed')
    if (event.subtype === 'started') {
      const item = toolItem(id, this.#turnId, name, call.args ?? {})
      this.#tools.set(id, item)
      events.push({ type: 'item.started', item })
    } else if (event.subtype === 'completed') {
      const item = this.#tools.get(id) ?? toolItem(id, this.#turnId, name, call.args ?? {})
      this.#tools.delete(id)
      events.push({ type: 'item.completed', item: { ...item, status: 'completed' } })
    }
    return events
  }

  #closeMessage(status: 'completed' | 'failed', durationMs?: number): DomainEvent[] {
    const message = this.#message
    if (!message) return []
    this.#message = undefined
    return [
      {
        type: 'item.completed',
        item: {
          id: message.id,
          turnId: this.#turnId,
          type: 'message',
          role: 'assistant',
          status,
          text: message.text,
          createdAt: Date.now(),
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      },
    ]
  }

  #result(event: CursorEvent): DomainEvent[] {
    const events = this.#closeMessage(event.is_error ? 'failed' : 'completed', event.duration_ms)
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
