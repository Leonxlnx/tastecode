import type { DomainEvent, Item, PlanStep } from '@harness/contracts'
import type { SessionUpdate, ToolCallContent, ToolKind } from './protocol.js'

/**
 * Translate one `session/update` into domain events.
 *
 * ACP streams text in chunks with no item identity of its own, so consecutive
 * chunks of the same kind have to be folded into one item here. `Streamer`
 * holds that little bit of state; without it every chunk becomes its own
 * message bubble and a paragraph arrives as thirty rows.
 */

/** ACP tool kinds mapped onto how we render them. */
const KIND_TO_ITEM: Partial<Record<ToolKind, Item['type']>> = {
  execute: 'command',
  edit: 'file_change',
  delete: 'file_change',
  move: 'file_change',
  think: 'reasoning',
}

export class Streamer {
  #turnId: string
  /** The item currently accumulating text, per kind. */
  #open = new Map<'message' | 'reasoning', string>()
  #counter = 0

  constructor(turnId: string) {
    this.#turnId = turnId
  }

  /** Called when a turn ends, so the next one does not append to a stale item. */
  reset(): void {
    this.#open.clear()
  }

  translate(update: SessionUpdate): DomainEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.#chunk('message', textOf(update.content))
      case 'agent_thought_chunk':
        return this.#chunk('reasoning', textOf(update.content))
      case 'tool_call':
      case 'tool_call_update':
        return this.#toolCall(update)
      case 'plan':
        return [{ type: 'plan.updated', turnId: this.#turnId, steps: toPlanSteps(update) }]
      default:
        // Modes, available commands, and whatever an agent invents next. Not
        // dropping them silently would mean rendering noise; they are logged
        // by the adapter instead.
        return []
    }
  }

  /**
   * Text arrives in chunks. The first opens an item, the rest are deltas
   * against it — which is what lets the UI render a growing paragraph rather
   * than a list of fragments.
   */
  #chunk(kind: 'message' | 'reasoning', text: string): DomainEvent[] {
    if (!text) return []

    const existing = this.#open.get(kind)
    if (existing) {
      return [{ type: 'item.delta', turnId: this.#turnId, itemId: existing, textDelta: text }]
    }

    const id = `${this.#turnId}-${kind}-${++this.#counter}`
    this.#open.set(kind, id)
    return [
      {
        type: 'item.started',
        item: {
          id,
          turnId: this.#turnId,
          type: kind,
          status: 'started',
          ...(kind === 'message' ? { role: 'assistant' as const } : {}),
          text,
          createdAt: Date.now(),
        },
      },
    ]
  }

  #toolCall(update: SessionUpdate): DomainEvent[] {
    const id = update.toolCallId ?? `${this.#turnId}-tool-${++this.#counter}`
    const type = (update.kind && KIND_TO_ITEM[update.kind]) ?? 'tool_call'
    const finished = update.status === 'completed' || update.status === 'failed'

    // A tool call interrupts the prose around it. Leaving the message item open
    // across it would append the agent's next sentence to the paragraph from
    // before the call, which reads as one thought when it is two.
    this.#open.delete('message')

    const item: Item = {
      id,
      turnId: this.#turnId,
      type,
      status: update.status === 'failed' ? 'failed' : finished ? 'completed' : 'started',
      createdAt: Date.now(),
    }

    if (type === 'command') {
      // The title is the only place the command line appears; `rawInput` is
      // agent-specific and not reliably present.
      item.command = update.title ?? 'command'
    } else if (type === 'file_change') {
      item.path =
        update.locations?.[0]?.path ?? pathFromContent(update.content) ?? update.title ?? ''
    } else {
      item.text = update.title ?? 'tool'
    }

    const output = outputOf(update.content)
    if (output) item.text = item.text ? `${item.text}\n${output}` : output

    const events: DomainEvent[] = [
      finished ? { type: 'item.completed', item } : { type: 'item.started', item },
    ]

    const diff = diffOf(update.content)
    if (diff) events.push({ type: 'diff.updated', turnId: this.#turnId, diff })

    return events
  }
}

function textOf(content: SessionUpdate['content']): string {
  if (!content || Array.isArray(content)) return ''
  return content.text ?? ''
}

/** Text a tool produced, so a command's output is visible under the command. */
function outputOf(content: SessionUpdate['content']): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part.type === 'content' ? (part.content?.text ?? '') : ''))
    .join('')
    .trim()
}

function pathFromContent(content: SessionUpdate['content']): string | undefined {
  if (!Array.isArray(content)) return undefined
  const diff = content.find((part) => part.type === 'diff')
  return diff?.type === 'diff' ? diff.path : undefined
}

/**
 * ACP reports an edit as before/after text, not as a patch. We forward the two
 * sides rather than diffing them here — inventing a unified diff from a
 * whole-file replacement would be a worse lie than showing what was sent.
 */
function diffOf(content: SessionUpdate['content']): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content.filter(
    (part): part is Extract<ToolCallContent, { type: 'diff' }> => part.type === 'diff',
  )
  if (parts.length === 0) return undefined

  return parts
    .map((part) => {
      const path = part.path ?? 'file'
      const before = part.oldText ?? ''
      const after = part.newText ?? ''
      return `--- a/${path}\n+++ b/${path}\n${body(before, '-')}${body(after, '+')}`
    })
    .join('\n')
}

function body(text: string, sign: '+' | '-'): string {
  if (text === '') return ''
  return (
    text
      .split('\n')
      .map((line) => `${sign}${line}`)
      .join('\n') + '\n'
  )
}

function toPlanSteps(update: SessionUpdate): PlanStep[] {
  return (update.entries ?? []).map((entry) => ({
    text: entry.content ?? '',
    status:
      entry.status === 'completed'
        ? 'done'
        : entry.status === 'in_progress'
          ? 'running'
          : 'pending',
  }))
}
