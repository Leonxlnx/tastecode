import type { DomainEvent, Item, Usage } from '@harness/contracts'
import type { Event, Part, ToolPart } from '@opencode-ai/sdk'

export class OpenCodeEventMapper {
  readonly #turnId: string
  readonly #open = new Map<string, Item>()
  readonly #text = new Map<string, string>()
  readonly #completed = new Set<string>()

  constructor(turnId: string) {
    this.#turnId = turnId
  }

  translate(event: Event): DomainEvent[] {
    if (event.type === 'message.part.updated')
      return this.#part(event.properties.part, event.properties.delta)
    if (event.type === 'message.updated') {
      const info = event.properties.info
      if (info.role === 'assistant' && info.time.completed) return [usage(info.tokens, info.cost)]
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
            ? { text: state.status === 'error' ? state.error : `${state.title}\n${state.output}` }
            : {}),
          ...('time' in state && state.time.end
            ? { durationMs: state.time.end - state.time.start }
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
): DomainEvent {
  const value: Usage = {
    inputTokens: tokens.input,
    cachedInputTokens: tokens.cache.read,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    totalTokens: tokens.input + tokens.output + tokens.reasoning,
    costUsd: cost,
  }
  return { type: 'usage.updated', usage: value }
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
  return typeof value === 'string' ? value : ''
}
