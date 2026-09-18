import { fileURLToPath } from 'node:url'
import type { DomainEvent, Item, ProviderHistorySession } from '@harness/contracts'

type RecordValue = Record<string, unknown>
type TurnStatus = 'completed' | 'failed' | 'interrupted'
type ContentParts = { text: string; attachments: string[] }

export function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {}
}

export function text(value: unknown) {
  return typeof value === 'string' && value.length ? value : undefined
}
function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** ACP updates retain display content, timing, diffs and turn boundaries lost from model history. */
export function grokHistoryEvents(
  session: ProviderHistorySession,
  updates: RecordValue[],
  chat: RecordValue[],
) {
  const replay = new Replay(session)
  const seen = new Set<string>()
  const backgroundTools = new Map<string, string>()
  const promptIds = new Map<number, string>()
  let nextPromptId: string | undefined
  for (let index = updates.length - 1; index >= 0; index--) {
    const params = record(updates[index]?.params),
      update = record(params.update)
    nextPromptId = text(record(params._meta).promptId) ?? text(update.prompt_id) ?? nextPromptId
    if (update.sessionUpdate === 'user_message_chunk') {
      if (nextPromptId) promptIds.set(index, nextPromptId)
    }
  }
  for (const [index, row] of updates.entries()) {
    const params = record(row.params),
      update = record(params.update),
      meta = record(params._meta)
    const eventId = text(meta.eventId)
    if (eventId && seen.has(eventId)) continue
    if (eventId) seen.add(eventId)
    const type = update.sessionUpdate
    const time =
      number(meta.agentTimestampMs) ?? (number(row.timestamp) ?? session.createdAt / 1000) * 1000
    if (type === 'user_message_chunk' && record(update._meta).hideFromScrollback !== true) {
      replay.user(
        update.content,
        time,
        number(record(update._meta).promptIndex),
        promptIds.get(index),
      )
    } else if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      replay.ensureTurn(time, text(meta.promptId))
      replay.message(type === 'agent_message_chunk' ? 'message' : 'reasoning', update.content, time)
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      replay.ensureTurn(time, text(meta.promptId))
      replay.tool(update, time)
    } else if (type === 'plan') {
      replay.ensureTurn(time, text(meta.promptId))
      replay.plan(update.entries)
    } else if (type === 'task_backgrounded') {
      const taskId = text(update.task_id),
        toolId = text(update.tool_call_id)
      if (taskId && toolId) backgroundTools.set(taskId, toolId)
    } else if (type === 'task_completed') {
      const task = record(update.task_snapshot)
      const taskId = text(task.task_id)
      if (taskId) replay.backgroundResult(backgroundTools.get(taskId), task, time)
    } else if (type === 'turn_completed') {
      const reason = update.stop_reason
      replay.finish(
        reason === 'end_turn' ? 'completed' : reason === 'error' ? 'failed' : 'interrupted',
        time,
      )
    }
  }
  if (!replay.hasItems) replayChat(replay, chat, session.createdAt)
  replay.finish('interrupted', session.updatedAt)
  return replay.events
}

class Replay {
  readonly events: DomainEvent[]
  hasItems = false
  #session: ProviderHistorySession
  #turn = ''
  #turnIndex = 0
  #itemIndex = 0
  #promptId: string | undefined
  #promptIndex: number | undefined
  #items: Item[] = []
  #tools = new Map<string, Item>()
  #allTools = new Map<string, Item>()
  #toolLabels = new Map<string, string>()
  #activeText: Item | undefined
  #responded = false

  constructor(session: ProviderHistorySession) {
    this.#session = session
    this.events = [
      {
        type: 'thread.started',
        thread: {
          id: session.id,
          provider: 'grok',
          workspacePath: session.workspacePath,
          title: session.title,
          createdAt: session.createdAt,
        },
      },
    ]
  }

  ensureTurn(time: number, promptId?: string) {
    if (this.#turn && promptId && this.#promptId && promptId !== this.#promptId)
      this.finish('interrupted', time)
    if (!this.#turn) {
      this.#turn = promptId ?? `${this.#session.id}:turn:${this.#turnIndex++}`
      this.events.push({
        type: 'turn.started',
        turn: { id: this.#turn, threadId: this.#session.id, status: 'running', createdAt: time },
      })
    }
    if (promptId) this.#promptId = promptId
  }

  user(content: unknown, time: number, promptIndex?: number, promptId?: string) {
    if (
      this.#turn &&
      (this.#responded ||
        (promptIndex !== undefined &&
          this.#promptIndex !== undefined &&
          promptIndex !== this.#promptIndex))
    )
      this.finish('interrupted', time)
    this.ensureTurn(time, promptId)
    this.#promptIndex = promptIndex
    this.message('message', content, time, 'user')
  }

  message(
    type: 'message' | 'reasoning',
    content: unknown,
    time: number,
    role: 'user' | 'assistant' = 'assistant',
  ) {
    const parsed = contentParts(content)
    if (!parsed.text && !parsed.attachments.length) return
    let item = this.#activeText
    if (!item || item.type !== type || item.role !== (type === 'message' ? role : undefined)) {
      item = this.add({
        type,
        status: 'completed',
        ...(type === 'message' ? { role } : {}),
        text: '',
        createdAt: time,
      })
      this.#activeText = item
    }
    item.text = (item.text ?? '') + parsed.text
    if (parsed.attachments.length)
      item.attachments = [...(item.attachments ?? []), ...parsed.attachments]
    if (role === 'assistant') this.#responded = true
  }

  tool(update: RecordValue, time: number) {
    this.#activeText = undefined
    this.#responded = true
    const id = text(update.toolCallId)
    if (!id) return
    let item = this.#tools.get(id)
    const native = record(record(update._meta)['x.ai/tool'])
    const input = record(update.rawInput)
    const name = text(native.name) ?? text(update.title) ?? 'Tool'
    const kind = text(update.kind) ?? text(native.kind)
    const command = text(input.command)
    const file = text(input.file_path) ?? text(input.path) ?? text(input.target_file)
    const type =
      kind === 'execute' || name === 'run_terminal_command'
        ? 'command'
        : kind === 'edit' || name === 'write' || name === 'search_replace'
          ? 'file_change'
          : 'tool_call'
    if (!item) {
      item = this.add({
        type,
        status: 'started',
        text: type === 'tool_call' ? name : '',
        createdAt: time,
      })
      this.#tools.set(id, item)
      this.#allTools.set(id, item)
    }
    if (Object.keys(input).length || !this.#toolLabels.has(id))
      this.#toolLabels.set(
        id,
        `${text(update.title) ?? name}${Object.keys(input).length ? `\n${JSON.stringify(input, null, 2)}` : ''}`,
      )
    if (kind || native.name) item.type = type
    if (command) {
      item.command = command
      item.type = 'command'
    }
    if (file) item.path = file
    if (
      item.type === 'file_change' &&
      file &&
      (typeof input.content === 'string' || typeof input.new_string === 'string')
    ) {
      const before = text(input.old_string) ?? '',
        after = text(input.new_string) ?? text(input.content) ?? ''
      item.text = unifiedDiff(file, before, after)
      item.linesAdded = lines(after).length
      item.linesRemoved = lines(before).length
    }
    const output = record(update.rawOutput)
    const exitCode = number(output.exit_code)
    if (exitCode !== undefined) item.exitCode = exitCode
    const parts = contentParts(update.content)
    const diff = array(update.content)
      .map(record)
      .find((part) => part.type === 'diff')
    if (diff) {
      item.type = 'file_change'
      const filename = text(diff.path) ?? file ?? 'file'
      item.path = filename
      const oldText = text(diff.oldText) ?? '',
        newText = text(diff.newText) ?? ''
      item.text = unifiedDiff(filename, oldText, newText)
      item.linesAdded = lines(newText).length
      item.linesRemoved = lines(oldText).length
    } else {
      const value = parts.text || outputText(update.rawOutput)
      if (value) {
        if (item.type === 'file_change' && item.text?.startsWith('--- ')) item.text += `\n${value}`
        else
          item.text =
            item.type === 'tool_call' ? `${this.#toolLabels.get(id) ?? name}\n${value}` : value
      }
    }
    if (
      item.type === 'tool_call' &&
      item.status === 'started' &&
      !parts.text &&
      update.rawOutput === undefined
    )
      item.text = this.#toolLabels.get(id) ?? name
    if (parts.attachments.length) item.attachments = parts.attachments
    if (update.status === 'completed' || update.status === 'failed') {
      item.status =
        update.status === 'failed' || (exitCode !== undefined && exitCode !== 0)
          ? 'failed'
          : 'completed'
      item.durationMs = Math.max(0, time - item.createdAt)
    }
  }

  backgroundResult(toolId: string | undefined, task: RecordValue, time: number) {
    const item = toolId ? this.#allTools.get(toolId) : undefined
    if (!item) return
    const output = text(task.output),
      exitCode = number(task.exit_code)
    if (output !== undefined) item.text = output
    if (exitCode !== undefined) item.exitCode = exitCode
    item.status = exitCode === undefined || exitCode === 0 ? 'completed' : 'failed'
    item.durationMs = Math.max(0, time - item.createdAt)
  }

  plan(entries: unknown) {
    this.#activeText = undefined
    const steps = array(entries)
      .map(record)
      .flatMap((entry) => {
        const value = text(entry.content)
        if (!value) return []
        const status =
          entry.status === 'completed'
            ? 'done'
            : entry.status === 'in_progress'
              ? 'running'
              : 'pending'
        return [{ text: value, status } as const]
      })
    if (steps.length) this.events.push({ type: 'plan.updated', turnId: this.#turn, steps })
  }

  finish(status: TurnStatus, time: number) {
    if (!this.#turn) return
    for (const item of this.#items) if (item.status === 'started') item.status = 'failed'
    const last = this.#items.findLast(
      (item) => item.type === 'message' && item.role === 'assistant',
    )
    for (const item of this.#items)
      if (item.type === 'message' && item.role === 'assistant') {
        item.phase = item === last && status === 'completed' ? 'final_answer' : 'commentary'
      }
    this.events.push({ type: 'turn.completed', turnId: this.#turn, status, completedAt: time })
    this.#turn = ''
    this.#promptId = undefined
    this.#promptIndex = undefined
    this.#items = []
    this.#tools.clear()
    this.#activeText = undefined
    this.#responded = false
  }

  add(value: Omit<Item, 'id' | 'turnId'>) {
    const item: Item = {
      ...value,
      id: `${this.#session.id}:item:${this.#itemIndex++}`,
      turnId: this.#turn,
    }
    this.#items.push(item)
    this.events.push({ type: 'item.completed', item })
    this.hasItems = true
    return item
  }
}

function contentParts(value: unknown): ContentParts {
  if (typeof value === 'string') return { text: value, attachments: [] }
  if (Array.isArray(value)) {
    const parts = value.map(contentParts)
    return {
      text: parts.map((p) => p.text).join(''),
      attachments: parts.flatMap((p) => p.attachments),
    }
  }
  const part = record(value)
  if (part.type === 'diff') return { text: '', attachments: [] }
  if (part.type === 'content') return contentParts(part.content)
  if (part.type === 'text' || part.type === 'summary_text')
    return { text: text(part.text) ?? '', attachments: [] }
  const resource = record(part.resource)
  const uri =
    text(part.uri) ??
    text(part.url) ??
    text(record(part.image_url).url) ??
    text(resource.uri) ??
    text(part.path)
  if (uri) {
    let location = uri
    if (uri.startsWith('file:')) {
      try {
        location = fileURLToPath(uri)
      } catch {
        /* Keep a malformed URI visible as saved. */
      }
    }
    return { text: text(resource.text) ?? '', attachments: [location] }
  }
  if (part.type === 'image' && text(part.data) && text(part.mimeType))
    return { text: '', attachments: [`data:${part.mimeType};base64,${part.data}`] }
  return { text: '', attachments: [] }
}

function outputText(value: unknown, depth = 0): string {
  if (depth > 8) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value))
    return value.every((v) => typeof v === 'number')
      ? Buffer.from(value).toString('utf8')
      : value.map((v) => outputText(v, depth + 1)).join('\n')
  const output = record(value)
  for (const key of [
    'output_for_prompt',
    'text',
    'content',
    'output',
    'stdout',
    'message',
    'result',
    'FileContent',
    'Content',
  ]) {
    if (output[key] !== undefined) return outputText(output[key], depth + 1)
  }
  return Object.keys(output).length ? JSON.stringify(output, null, 2) : ''
}

function lines(value: string) {
  return value ? value.replace(/\n$/, '').split('\n') : []
}
function unifiedDiff(file: string, before: string, after: string) {
  const oldLines = lines(before),
    newLines = lines(after)
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')
}

function replayChat(replay: Replay, rows: RecordValue[], time: number) {
  let hadResponse = false
  const indexedPrompts = rows.some(
    (candidate) => candidate.type === 'user' && candidate.prompt_index !== undefined,
  )
  for (const row of rows) {
    if (row.type === 'system' || row.synthetic_reason) continue
    // Grok injects context as user messages without a prompt index before the first real prompt.
    if (row.type === 'user') {
      if (indexedPrompts && row.prompt_index === undefined) continue
      if (hadResponse) replay.finish('completed', time)
      replay.user(row.content, time, number(row.prompt_index))
    } else if (row.type === 'assistant' || row.type === 'reasoning') {
      replay.ensureTurn(time)
      replay.message(
        row.type === 'reasoning' ? 'reasoning' : 'message',
        row.type === 'reasoning' ? row.summary : row.content,
        time,
      )
      for (const value of array(row.tool_calls)) {
        const call = record(value)
        let input: RecordValue = {}
        try {
          input = record(JSON.parse(text(call.arguments) ?? '{}'))
        } catch {
          /* Keep the tool even with partial input. */
        }
        replay.tool(
          {
            toolCallId: call.id,
            title: call.name,
            rawInput: input,
            _meta: { 'x.ai/tool': { name: call.name } },
          },
          time,
        )
      }
      hadResponse = true
    } else if (row.type === 'tool_result') {
      replay.ensureTurn(time)
      replay.tool(
        {
          toolCallId: row.tool_call_id,
          status: 'completed',
          content: [{ type: 'text', text: row.content }, ...array(row.images)],
        },
        time,
      )
    } else if (row.type === 'backend_tool_call') {
      replay.ensureTurn(time)
      const tool = record(row.kind)
      replay.tool(
        { toolCallId: tool.id, title: tool.tool_type, status: tool.status, rawOutput: tool.action },
        time,
      )
    }
  }
  if (hadResponse) replay.finish('completed', time)
}
