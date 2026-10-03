import type { DomainEvent, Item, PlanStep } from '@harness/contracts'
import path from 'node:path'
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
const KIND_TO_ITEM = new Map<ToolKind, Item['type']>([
  ['execute', 'command'],
  ['edit', 'file_change'],
  ['delete', 'file_change'],
  ['move', 'file_change'],
  ['think', 'reasoning'],
])

export class Streamer {
  #turnId: string
  readonly #workspacePath: string | undefined
  /** The item currently accumulating text, per kind. */
  #open = new Map<'message' | 'reasoning', Item>()
  /**
   * What each tool call was when it started.
   *
   * `tool_call_update` carries only what changed, so the completion frame
   * usually has no `kind` and no `title`. Without this a finished command
   * arrives as an anonymous "tool" and replaces the row that showed what was
   * actually run.
   */
  #tools = new Map<string, { kind?: ToolKind; title?: string; output?: string }>()
  #counter = 0
  /** Distinguishes successive id-less tool calls within one turn. */
  #anonymousSeq = 0

  constructor(turnId: string, workspacePath?: string) {
    this.#turnId = turnId
    this.#workspacePath = workspacePath
  }

  /**
   * Record what a tool call is before any update mentions it.
   *
   * A call that needs permission is described only in the permission request,
   * which is a JSON-RPC request rather than a session update. Its first and
   * only update is the completion, and that one carries no kind or title.
   */
  note(toolCallId: string, fields: { kind?: ToolKind; title?: string }): void {
    const known = this.#tools.get(toolCallId)
    const kind = fields.kind ?? known?.kind
    const title = fields.title ?? known?.title
    this.#tools.set(toolCallId, {
      ...(kind ? { kind } : {}),
      ...(title ? { title } : {}),
    })
  }

  /** Called when a turn ends, so the next one does not append to a stale item. */
  reset(): void {
    this.#open.clear()
    this.#tools.clear()
  }

  /** Finish streamed items before the turn closes so history has immutable text. */
  finish(): DomainEvent[] {
    const events = [this.#complete('message'), this.#complete('reasoning')].filter(
      (event): event is DomainEvent => event !== undefined,
    )
    this.#tools.clear()
    return events
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
      this.#open.set(kind, { ...existing, text: (existing.text ?? '') + text })
      return [{ type: 'item.delta', turnId: this.#turnId, itemId: existing.id, textDelta: text }]
    }

    const id = `${this.#turnId}-${kind}-${++this.#counter}`
    const item: Item = {
      id,
      turnId: this.#turnId,
      type: kind,
      status: 'started',
      ...(kind === 'message' ? { role: 'assistant' as const } : {}),
      text,
      createdAt: Date.now(),
    }
    this.#open.set(kind, item)
    return [
      {
        type: 'item.started',
        item,
      },
    ]
  }

  #complete(kind: 'message' | 'reasoning'): DomainEvent | undefined {
    const item = this.#open.get(kind)
    if (!item) return undefined
    this.#open.delete(kind)
    return { type: 'item.completed', item: { ...item, status: 'completed' } }
  }

  #toolCall(update: SessionUpdate): DomainEvent[] {
    // One shared slot for id-less frames: a fresh id per update would split a
    // call and its completion into two items, the first spinning forever. The
    // sequence number advances when a call finishes, so the NEXT id-less call
    // gets its own item instead of inheriting this one's identity and output.
    const id = update.toolCallId ?? `${this.#turnId}-tool-anonymous-${this.#anonymousSeq}`

    // An update carries only what changed. Fall back to what we recorded when
    // this call started, so a completion does not erase its own identity —
    // and accumulate output, because each frame carries only its own chunk.
    const known = this.#tools.get(id)
    const kind = update.kind ?? known?.kind
    const title = update.title ?? known?.title
    const chunk = outputOf(update.content)
    const output = chunk ? (known?.output ? `${known.output}${chunk}` : chunk) : known?.output
    this.#tools.set(id, {
      ...(kind ? { kind } : {}),
      ...(title ? { title } : {}),
      ...(output ? { output } : {}),
    })

    const type = (kind && KIND_TO_ITEM.get(kind)) ?? 'tool_call'
    const finished = update.status === 'completed' || update.status === 'failed'

    // A tool call interrupts the prose around it. Complete that message before
    // the tool so its text remains immutable and the next sentence starts fresh.
    const completedMessage = this.#complete('message')

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
      item.command = title ?? 'command'
    } else if (type === 'file_change') {
      item.path = update.locations?.[0]?.path ?? pathFromContent(update.content) ?? title ?? ''
    } else {
      item.text = title ?? 'tool'
    }

    if (output) item.text = item.text ? `${item.text}\n${output}` : output

    if (finished && !update.toolCallId) {
      this.#tools.delete(id)
      this.#anonymousSeq++
    }

    const events: DomainEvent[] = [
      ...(completedMessage ? [completedMessage] : []),
      finished ? { type: 'item.completed', item } : { type: 'item.started', item },
    ]

    const diff = diffOf(update.content, this.#workspacePath)
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

/** ACP's complete before/after files form a reversible whole-file hunk. */
function diffOf(content: SessionUpdate['content'], workspacePath?: string): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content.filter(
    (part): part is Extract<ToolCallContent, { type: 'diff' }> => part.type === 'diff',
  )
  if (parts.length === 0) return undefined

  return (
    parts
      .map((part) => {
        if (!part.path || part.oldText === undefined || part.newText === undefined) return ''
        const filePath = (
          workspacePath && path.isAbsolute(part.path)
            ? path.relative(workspacePath, part.path)
            : part.path
        )
          .split(path.sep)
          .join('/')
        const before = part.oldText ?? ''
        const after = part.newText ?? ''
        if (before === after && part.oldText !== null) return ''
        const oldCount = lineCount(before)
        const newCount = lineCount(after)
        const oldPath = JSON.stringify(`a/${filePath}`)
        const newPath = JSON.stringify(`b/${filePath}`)
        const headers = [
          `diff --git ${oldPath} ${newPath}`,
          ...(part.oldText === null ? ['new file mode 100644'] : []),
          `--- ${part.oldText === null ? '/dev/null' : oldPath}`,
          `+++ ${newPath}`,
        ]
        if (oldCount || newCount) {
          headers.push(`@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@`)
        }
        return `${headers.join('\n')}\n${body(before, '-')}${body(after, '+')}`
      })
      .filter(Boolean)
      .join('\n') || undefined
  )
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

function body(text: string, sign: '+' | '-'): string {
  if (text === '') return ''
  return (
    text
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => `${sign}${line}`)
      .join('\n') +
    '\n' +
    (text.endsWith('\n') ? '' : '\\ No newline at end of file\n')
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
