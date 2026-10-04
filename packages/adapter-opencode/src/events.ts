import type { DomainEvent, Item, Usage } from '@harness/contracts'
import { JsonRpcValueSchema, type JsonRpcValue } from '@harness/proc'
import type { Event, Part, ToolPart } from '@opencode-ai/sdk'
import { z } from 'zod'

/** OpenCode 2.0's `/api/event` stream. Its generated SDK is still changing,
 *  so this adapter follows the captured wire shape instead of importing a
 *  prerelease type that can drift independently of the installed binary. */
export const OpenCodeDataSchema = z.record(z.string(), JsonRpcValueSchema)
export const OpenCodeV2EventSchema = z.object({
  id: z.string().optional(),
  created: z.number().optional(),
  type: z.string(),
  data: OpenCodeDataSchema,
})
export type OpenCodeV2Event = z.infer<typeof OpenCodeV2EventSchema>

export type OpenCodeLegacyLifecycleEvent =
  | { type: 'session.status'; properties: { sessionID: string; status: { type: string } } }
  | { type: 'session.idle'; properties: { sessionID: string } }

export type OpenCodeWireEvent = Event | OpenCodeV2Event | OpenCodeLegacyLifecycleEvent

export class OpenCodeEventMapper {
  readonly #turnId: string
  readonly #model: string | undefined
  readonly #open = new Map<string, Item>()
  readonly #text = new Map<string, string>()
  readonly #completed = new Set<string>()
  readonly #v2Tools = new Map<string, { name: string; input?: Record<string, JsonRpcValue> }>()

  constructor(turnId: string, model?: string) {
    this.#turnId = turnId
    this.#model = model
  }

  translate(event: OpenCodeWireEvent): DomainEvent[] {
    if ('data' in event) return this.#v2(event)
    if (event.type === 'session.status' || event.type === 'session.idle') return []
    if (event.type === 'message.part.updated')
      return this.#part(event.properties.part, event.properties.delta)
    if (event.type === 'message.updated') {
      const info = event.properties.info
      if (info.role === 'assistant' && info.time.completed) {
        return [usage(info.tokens, info.cost, `${info.providerID}/${info.modelID}`)]
      }
    }
    if (event.type === 'session.diff') {
      return event.properties.diff.map((diff, index) => ({
        type: 'item.completed',
        item: {
          id: `${this.#turnId}-diff-${index}`,
          turnId: this.#turnId,
          type: 'file_change',
          status: 'completed',
          path: diff.file,
          linesAdded: diff.additions,
          linesRemoved: diff.deletions,
          createdAt: Date.now(),
        },
      }))
    }
    return []
  }

  #v2(event: OpenCodeV2Event): DomainEvent[] {
    const data = event.data
    if (event.type === 'session.text.started') return this.#v2Stream(data, 'message', 'started')
    if (event.type === 'session.text.delta') return this.#v2Stream(data, 'message', 'delta')
    if (event.type === 'session.text.ended') return this.#v2Stream(data, 'message', 'ended')
    if (event.type === 'session.reasoning.started')
      return this.#v2Stream(data, 'reasoning', 'started')
    if (event.type === 'session.reasoning.delta') return this.#v2Stream(data, 'reasoning', 'delta')
    if (event.type === 'session.reasoning.ended') return this.#v2Stream(data, 'reasoning', 'ended')
    if (event.type === 'session.tool.input.started') {
      const id = string(data.id)
      if (id) this.#v2Tools.set(id, { name: string(data.name) || 'tool' })
      return []
    }
    if (event.type === 'session.tool.called') return this.#v2Tool(data, 'started')
    if (event.type === 'session.tool.success') return this.#v2Tool(data, 'completed')
    if (event.type === 'session.tool.failed') return this.#v2Tool(data, 'failed')
    // v2 emits both `session.step.ended` and a cumulative
    // `session.usage.updated` for the same step. The latter is the stable
    // turn-level value; mapping both would publish every usage update twice.
    if (event.type === 'session.usage.updated') return [v2Usage(data, this.#model)]
    return []
  }

  #v2Stream(
    data: Record<string, JsonRpcValue>,
    type: 'message' | 'reasoning',
    phase: 'started' | 'delta' | 'ended',
  ): DomainEvent[] {
    const messageId = string(data.assistantMessageID) || 'assistant'
    const ordinal = number(data['ordinal'])
    const id = `${this.#turnId}-${messageId}-${type}-${ordinal}`
    const events: DomainEvent[] = []
    if (!this.#open.has(id)) {
      const item: Item = {
        id,
        turnId: this.#turnId,
        type,
        ...(type === 'message' ? { role: 'assistant' as const } : {}),
        status: 'started',
        text: '',
        createdAt: Date.now(),
      }
      this.#open.set(id, item)
      this.#text.set(id, '')
      events.push({ type: 'item.started', item })
    }
    const previous = this.#text.get(id) ?? ''
    const value =
      phase === 'delta' ? string(data.delta) : phase === 'ended' ? string(data.text) : ''
    const delta =
      phase === 'delta'
        ? value
        : value && value.startsWith(previous)
          ? value.slice(previous.length)
          : ''
    if (delta) {
      this.#text.set(id, phase === 'delta' ? previous + delta : value)
      events.push({ type: 'item.delta', turnId: this.#turnId, itemId: id, textDelta: delta })
    }
    if (phase === 'ended' && !this.#completed.has(id)) {
      if (value && !this.#text.get(id)) this.#text.set(id, value)
      this.#completed.add(id)
      events.push({
        type: 'item.completed',
        item: { ...this.#open.get(id)!, status: 'completed', text: this.#text.get(id) ?? value },
      })
    }
    return events
  }

  #v2Tool(
    data: Record<string, JsonRpcValue>,
    status: 'started' | 'completed' | 'failed',
  ): DomainEvent[] {
    const callId = string(data.id)
    if (!callId) return []
    const known = this.#v2Tools.get(callId) ?? { name: 'tool' }
    if (status === 'started') {
      const input = record(data.input)
      this.#v2Tools.set(callId, { ...known, input })
    }
    const current = this.#v2Tools.get(callId) ?? known
    const kind = toolKind(current.name)
    const input = current.input ?? {}
    const command = string(input.command) || string(input.cmd) || current.name
    const path = string(input.filePath) || string(input.path)
    const id = `${this.#turnId}-${callId}`
    const item: Item = {
      id,
      turnId: this.#turnId,
      type: kind,
      status: 'started',
      ...(kind === 'command' ? { command } : {}),
      ...(kind === 'file_change' && path ? { path } : {}),
      ...(kind === 'tool_call' ? { text: current.name } : {}),
      createdAt: Date.now(),
    }
    const events: DomainEvent[] = []
    if (!this.#open.has(id)) {
      this.#open.set(id, item)
      events.push({ type: 'item.started', item })
    }
    if (status !== 'started' && !this.#completed.has(id)) {
      this.#completed.add(id)
      const output = contentText(data.content) || string(record(data.error).message)
      events.push({
        type: 'item.completed',
        item: {
          ...item,
          status,
          ...(kind === 'tool_call' && output ? { text: output } : {}),
        },
      })
    }
    return events
  }

  finish(status: 'completed' | 'failed' = 'completed'): DomainEvent[] {
    const events = [...this.#open.values()]
      .filter((item) => !this.#completed.has(item.id))
      .map((item) => ({
        type: 'item.completed' as const,
        item: { ...item, status, text: this.#text.get(item.id) ?? item.text },
      }))
    for (const event of events) this.#completed.add(event.item.id)
    return events
  }

  #part(part: Part, delta?: string): DomainEvent[] {
    if (part.type === 'text' || part.type === 'reasoning') {
      const id = `${this.#turnId}-${part.id}`
      const events: DomainEvent[] = []
      if (!this.#open.has(id)) {
        const item: Item = {
          id,
          turnId: this.#turnId,
          type: part.type === 'text' ? 'message' : 'reasoning',
          ...(part.type === 'text' ? { role: 'assistant' as const } : {}),
          status: 'started',
          text: '',
          createdAt: part.time?.start ?? Date.now(),
        }
        this.#open.set(id, item)
        this.#text.set(id, '')
        events.push({ type: 'item.started', item })
      }
      const previous = this.#text.get(id) ?? ''
      const next =
        delta ?? (part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text)
      if (next) {
        this.#text.set(id, delta ? previous + delta : part.text)
        events.push({ type: 'item.delta', turnId: this.#turnId, itemId: id, textDelta: next })
      }
      if (part.time?.end && !this.#completed.has(id)) {
        this.#completed.add(id)
        events.push({
          type: 'item.completed',
          item: { ...this.#open.get(id)!, status: 'completed', text: this.#text.get(id) },
        })
      }
      return events
    }
    if (part.type === 'tool') return this.#tool(part)
    if (part.type === 'step-finish') return [usage(part.tokens, part.cost)]
    return []
  }

  #tool(part: ToolPart): DomainEvent[] {
    const id = `${this.#turnId}-${part.id}`
    const state = part.state
    const kind = toolKind(part.tool)
    const input = state.input
    const command = string(input.command) || string(input.cmd) || stateTitle(state) || part.tool
    const path = string(input.filePath) || string(input.path)
    const item: Item = {
      id,
      turnId: this.#turnId,
      type: kind,
      status: 'started',
      ...(kind === 'command' ? { command } : {}),
      ...(kind === 'file_change' && path ? { path } : {}),
      ...(kind === 'tool_call' ? { text: stateTitle(state) || part.tool } : {}),
      createdAt: 'time' in state ? state.time.start : Date.now(),
    }
    const events: DomainEvent[] = []
    if (!this.#open.has(id)) {
      this.#open.set(id, item)
      events.push({ type: 'item.started', item })
    }
    if ((state.status === 'completed' || state.status === 'error') && !this.#completed.has(id)) {
      this.#completed.add(id)
      events.push({
        type: 'item.completed',
        item: {
          ...item,
          status: state.status === 'error' ? 'failed' : 'completed',
          ...(kind === 'tool_call'
            ? {
                text: state.status === 'error' ? state.error : `${state.title}\n${state.output}`,
              }
            : {}),
          ...('time' in state && state.time.end
            ? {
                durationMs: state.time.end - state.time.start,
              }
            : {}),
        },
      })
    }
    return events
  }
}

function usage(
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  },
  cost: number,
  model?: string,
): DomainEvent {
  const output = tokens.output + tokens.reasoning
  const value: Usage = {
    ...(model ? { model } : {}),
    inputTokens: tokens.input,
    cachedInputTokens: tokens.cache.read,
    outputTokens: output,
    reasoningTokens: tokens.reasoning,
    totalTokens: tokens.input + tokens.cache.read + tokens.cache.write + output,
    costUsd: cost,
    inputIncludesCached: false,
  }
  return { type: 'usage.updated', usage: value }
}

function v2Usage(data: Record<string, JsonRpcValue>, model?: string): DomainEvent {
  const tokens = record(data['tokens'])
  const cache = record(tokens['cache'])
  const input = number(tokens['input'])
  const output = number(tokens['output'])
  const reasoning = number(tokens['reasoning'])
  const normalizedOutput = output + reasoning
  return {
    type: 'usage.updated',
    usage: {
      ...(model ? { model } : {}),
      inputTokens: input,
      cachedInputTokens: number(cache['read']),
      outputTokens: normalizedOutput,
      reasoningTokens: reasoning,
      totalTokens: input + number(cache['read']) + number(cache['write']) + normalizedOutput,
      costUsd: number(data['cost']),
      inputIncludesCached: false,
    },
  }
}

function toolKind(name: string): Item['type'] {
  if (/^(bash|shell|command)$/i.test(name)) return 'command'
  if (/^(edit|write|patch|multiedit)$/i.test(name)) return 'file_change'
  return 'tool_call'
}

function stateTitle(state: ToolPart['state']): string {
  return 'title' in state ? (state.title ?? '') : ''
}

function string(value: unknown): string {
  const parsed = z.string().safeParse(value)
  return parsed.success ? parsed.data : ''
}

function number(value: unknown): number {
  const parsed = z.number().safeParse(value)
  return parsed.success && Number.isFinite(parsed.data) ? parsed.data : 0
}

function record(value: unknown): Record<string, JsonRpcValue> {
  const parsed = OpenCodeDataSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function contentText(value: unknown): string {
  const parsed = z.array(OpenCodeDataSchema).safeParse(value)
  if (!parsed.success) return ''
  return parsed.data
    .map((entry) => {
      const item = record(entry)
      return string(item.text) || string(item.output)
    })
    .filter(Boolean)
    .join('\n')
}
