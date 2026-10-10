import type { DomainEvent, Item, PlanStep } from '@harness/contracts'
import path from 'node:path'
import type { SessionUpdate, ToolCallContent, ToolKind } from './protocol.js'

type DiffPart = Extract<ToolCallContent, { type: 'diff' }>

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
  /**
   * Edits a tool call proposed before it finished.
   *
   * A permissioned edit describes its diff in the request or in a pending
   * frame; the completion may carry no content at all. Kept here so the edit
   * still reaches the turn diff once it really happens, and dropped if not.
   */
  #proposed = new Map<string, DiffPart[]>()
  /**
   * Every file this turn changed: the contents before its first edit and after
   * its latest. `diff.updated` is the whole turn's patch, so one edit's diff
   * alone would hide every earlier file from the panel and from Undo.
   */
  #files = new Map<string, { oldText: string | null; newText: string }>()
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
  note(
    toolCallId: string,
    fields: { kind?: ToolKind; title?: string; content?: ToolCallContent[] },
  ): void {
    const proposed = diffParts(fields.content)
    if (proposed.length > 0) this.#proposed.set(toolCallId, proposed)
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
    this.#proposed.clear()
    this.#files.clear()
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

    // Thinking and answering alternate. Close the other kind's item so a later
    // thought starts below the answer it follows instead of joining the first.
    const other = this.#complete(kind === 'message' ? 'reasoning' : 'message')
    const closed = other ? [other] : []

    const existing = this.#open.get(kind)
    if (existing) {
      this.#open.set(kind, { ...existing, text: (existing.text ?? '') + text })
      return [
        ...closed,
        { type: 'item.delta', turnId: this.#turnId, itemId: existing.id, textDelta: text },
      ]
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
      ...closed,
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

    // A tool call interrupts the prose and thinking around it. Complete both
    // before the tool so their text remains immutable and whatever follows the
    // tool starts a fresh item below it.
    const completedText = [this.#complete('reasoning'), this.#complete('message')].filter(
      (event): event is DomainEvent => event !== undefined,
    )

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
      ...completedText,
      finished ? { type: 'item.completed', item } : { type: 'item.started', item },
    ]

    const diff = this.#turnDiff(id, update)
    if (diff !== undefined) events.push({ type: 'diff.updated', turnId: this.#turnId, diff })

    return events
  }

  /**
   * The whole turn's patch after this update, or nothing when it is unchanged.
   *
   * Only a completed edit changes the turn. A pending or in-progress diff is a
   * proposal the user may still deny, so it waits in `#proposed`.
   */
  #turnDiff(id: string, update: SessionUpdate): string | undefined {
    const parts = diffParts(update.content)
    if (update.status === 'failed') {
      this.#proposed.delete(id)
      return undefined
    }
    if (update.status !== 'completed') {
      if (parts.length > 0) this.#proposed.set(id, parts)
      return undefined
    }

    const applied = parts.length > 0 ? parts : (this.#proposed.get(id) ?? [])
    this.#proposed.delete(id)
    let changed = false
    for (const part of applied) {
      if (!part.path || part.oldText === undefined || part.newText === undefined) continue
      const filePath = relativePath(part.path, this.#workspacePath)
      const known = this.#files.get(filePath)
      // A second edit to the same file starts from the first one's result, so
      // the turn's before-image stays the one from the first edit.
      this.#files.set(filePath, {
        oldText: known ? known.oldText : part.oldText,
        newText: part.newText,
      })
      changed = true
    }
    if (!changed) return undefined
    return (
      [...this.#files]
        .map(([filePath, file]) => fileDiff(filePath, file.oldText, file.newText))
        .filter(Boolean)
        // Each file's diff already ends in a newline; another would be read as a
        // blank context line of the previous hunk.
        .join('')
    )
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

function diffParts(content: SessionUpdate['content']): DiffPart[] {
  if (!Array.isArray(content)) return []
  return content.filter((part): part is DiffPart => part.type === 'diff')
}

function relativePath(filePath: string, workspacePath?: string): string {
  return (
    workspacePath && path.isAbsolute(filePath) ? path.relative(workspacePath, filePath) : filePath
  )
    .split(path.sep)
    .join('/')
}

/** ACP's complete before/after files form a reversible whole-file hunk. */
function fileDiff(filePath: string, oldText: string | null, newText: string): string {
  const before = oldText ?? ''
  const after = newText
  if (before === after && oldText !== null) return ''
  const oldCount = lineCount(before)
  const newCount = lineCount(after)
  const oldPath = JSON.stringify(`a/${filePath}`)
  const newPath = JSON.stringify(`b/${filePath}`)
  const headers = [
    `diff --git ${oldPath} ${newPath}`,
    ...(oldText === null ? ['new file mode 100644'] : []),
    `--- ${oldText === null ? '/dev/null' : oldPath}`,
    `+++ ${newPath}`,
  ]
  if (oldCount || newCount) {
    headers.push(`@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@`)
  }
  return `${headers.join('\n')}\n${body(before, '-')}${body(after, '+')}`
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
