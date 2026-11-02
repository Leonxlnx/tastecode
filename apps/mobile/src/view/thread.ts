import type { ApprovalRequest, Item, ProviderId, UserInputRequest } from '@harness/contracts'
import type { ThreadView } from '../state/thread-model'
import type { ApprovalView, QuestionsView, RowView, StepKind, StepRunView, StepView } from './types'

/**
 * A transcript row before wording: messages alone, steps of work together.
 * A settled turn's work is one group, with its notes inside, above its answer.
 */
export type Row =
  | { key: string; kind: 'user' | 'assistant' | 'notice' | 'error'; item: Item }
  | { key: string; kind: 'steps'; items: Item[]; live: boolean; settled: boolean; turnId: string }

const STEP_TYPES = new Set<Item['type']>([
  'command',
  'file_change',
  'tool_call',
  'reasoning',
  'plan',
  'unknown',
])

function messageRow(item: Item): Row {
  const kind =
    item.type === 'message'
      ? item.role === 'user'
        ? 'user'
        : 'assistant'
      : item.type === 'notice'
        ? 'notice'
        : 'error'
  return { key: item.id, kind, item }
}

const isAnswer = (item: Item) =>
  item.type === 'message' && item.role === 'assistant' && item.status === 'completed'

/**
 * The reply a settled turn ends on, as the desktop picks it: the last one
 * marked as the final answer, else the last one with no phase at all.
 */
function finalAnswer(items: readonly Item[]): Item | undefined {
  const answers = items.filter(isAnswer)
  return (
    answers.findLast((item) => item.phase === 'final_answer') ??
    answers.findLast((item) => item.phase === undefined)
  )
}

/** A turn while it works: its steps in batches between the messages, as they come. */
function liveRows(items: readonly Item[], live: boolean): Row[] {
  const rows: Row[] = []
  let steps: Item[] = []
  const flush = () => {
    const first = steps[0]
    if (first) {
      rows.push({
        key: `steps:${first.id}`,
        kind: 'steps',
        items: steps,
        live: false,
        settled: false,
        turnId: first.turnId,
      })
    }
    steps = []
  }
  for (const item of items) {
    if (STEP_TYPES.has(item.type)) steps.push(item)
    else {
      flush()
      rows.push(messageRow(item))
    }
  }
  flush()
  const last = rows.at(-1)
  if (live && last?.kind === 'steps') rows[rows.length - 1] = { ...last, live: true }
  return rows
}

/**
 * A settled turn the desktop way: the prompt, then one group holding every
 * step and every note the agent wrote on the way, then the answer it ended on.
 */
function settledRows(items: readonly Item[]): Row[] {
  const answer = finalAnswer(items)
  const work = items.filter(
    (item) =>
      item !== answer &&
      // Reasoning with nothing written has nothing to read; the desktop leaves it out too.
      !(item.type === 'reasoning' && !item.text?.trim()) &&
      (STEP_TYPES.has(item.type) || (item.type === 'message' && item.role === 'assistant')),
  )
  // Without an answer the turn has nothing to end on; the desktop leaves its batches in place too.
  if (!answer || !work.some((item) => STEP_TYPES.has(item.type))) return liveRows(items, false)
  const rows: Row[] = []
  let placed = false
  for (const item of items) {
    if (STEP_TYPES.has(item.type) && !work.includes(item)) continue
    if (item === answer || !work.includes(item)) {
      rows.push(messageRow(item))
    } else if (!placed) {
      placed = true
      rows.push({
        key: `work:${item.turnId}`,
        kind: 'steps',
        items: work,
        live: false,
        settled: true,
        turnId: item.turnId,
      })
    }
  }
  return rows
}

export function buildRows(view: ThreadView): Row[] {
  const rows: Row[] = []
  let turn: Item[] = []
  const flush = () => {
    const first = turn[0]
    if (!first) return
    const working = view.running && first.turnId === view.activeTurnId
    const settled = !working && view.turnEnded[first.turnId] !== undefined
    rows.push(...(settled ? settledRows(turn) : liveRows(turn, working)))
    turn = []
  }
  for (const item of view.items) {
    if (turn[0] && turn[0].turnId !== item.turnId) flush()
    turn.push(item)
  }
  flush()
  return rows
}

/** Whether a row's wording can still be reused: the same items, the same liveness. */
export function sameRow(left: Row, right: Row): boolean {
  if (left.kind !== right.kind || left.key !== right.key) return false
  if (left.kind === 'steps' && right.kind === 'steps') {
    return (
      left.live === right.live &&
      left.settled === right.settled &&
      left.items.length === right.items.length &&
      left.items.every((item, index) => item === right.items[index])
    )
  }
  return 'item' in left && 'item' in right && left.item === right.item
}

export function rowView(row: Row, view: ThreadView): RowView {
  if (row.kind === 'steps') {
    const from = view.turnStarted[row.turnId]
    const to = view.turnEnded[row.turnId]
    return {
      key: row.key,
      kind: 'steps',
      live: row.live,
      settled: row.settled,
      summary: row.settled
        ? `Worked for ${workedFor(row.items, from, to)}`
        : row.live
          ? liveSummary(row.items)
          : summarize(row.items),
      duration:
        !row.settled && !row.live && from !== undefined && to !== undefined && to > from
          ? duration(to - from)
          : null,
      failed: row.items.some(failed),
      steps: row.items.map(stepView),
      runs: row.settled ? stepRuns(row.items) : null,
    }
  }
  const { item } = row
  switch (row.kind) {
    case 'user':
      return {
        key: row.key,
        kind: 'user',
        text: item.text ?? '',
        attachments: item.attachments ?? [],
      }
    case 'assistant':
      return {
        key: row.key,
        kind: 'assistant',
        text: item.text ?? '',
        streaming: item.status === 'started',
      }
    case 'notice':
      return { key: row.key, kind: 'notice', text: noticeText(item) }
    case 'error':
      return { key: row.key, kind: 'error', text: item.text ?? 'Something went wrong.' }
  }
}

function failed(item: Item): boolean {
  return (
    item.status === 'failed' ||
    (item.type === 'command' && item.exitCode !== undefined && item.exitCode !== 0)
  )
}

function stepKind(item: Item): StepKind {
  switch (item.type) {
    case 'command':
      return 'command'
    case 'file_change':
      return 'file'
    case 'tool_call':
      return item.subagent ? 'agent' : isRead(item.text) ? 'read' : 'tool'
    case 'reasoning':
      return 'thinking'
    case 'plan':
      return 'plan'
    default:
      return 'other'
  }
}

/**
 * A settled group's steps in runs: each note stands alone, and everything the
 * agent did between two notes, thoughts included, folds under one summary.
 */
export function stepRuns(items: readonly Item[]): StepRunView[] {
  const runs: StepRunView[] = []
  let calls: Item[] = []
  const flush = () => {
    const first = calls[0]
    if (first) {
      const acted = calls.filter((item) => item.type !== 'reasoning')
      runs.push({
        id: `run:${first.id}`,
        summary:
          acted.length > 0
            ? summarize(acted)
            : calls.length === 1
              ? thoughtLabel(first)
              : 'Thought',
        steps: calls.map(stepView),
      })
    }
    calls = []
  }
  for (const item of items) {
    if (item.type === 'message') {
      flush()
      runs.push({ id: `run:${item.id}`, summary: null, steps: [stepView(item)] })
    } else {
      calls.push(item)
    }
  }
  flush()
  return runs
}

/** "Thought", or "Thought for 12s" once it took a second or more, as on the desktop. */
function thoughtLabel(item: Item): string {
  if (item.durationMs === undefined || item.durationMs < 1000) return 'Thought'
  return `Thought for ${duration(item.durationMs)}`
}

/** A turn's length as the desktop writes it: "3m 18s", "1h 2m 5s". */
function workedFor(
  items: readonly Item[],
  from: number | undefined,
  to: number | undefined,
): string {
  const ms =
    from !== undefined && to !== undefined
      ? to - from
      : Math.max(...items.map((item) => item.createdAt)) -
        Math.min(...items.map((item) => item.createdAt))
  let remaining = Math.max(1, Math.round(ms / 1000))
  const parts: string[] = []
  for (const [unit, seconds] of [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    const value = Math.floor(remaining / seconds)
    remaining %= seconds
    if (value > 0) parts.push(`${value}${unit}`)
  }
  return parts.join(' ')
}

export function stepView(item: Item): StepView {
  if (item.type === 'message') {
    // A note the agent wrote on the way, kept with the work it explains.
    return {
      id: item.id,
      kind: 'note',
      title: item.text?.trim() ?? '',
      detail: null,
      added: null,
      removed: null,
      running: false,
      failed: false,
    }
  }
  const kind = stepKind(item)
  let title: string
  let detail: string | null = null
  switch (kind) {
    case 'command':
      // One line until the step opens; then the whole command.
      title = (item.command ?? item.text ?? 'Command').trim()
      if (item.durationMs !== undefined) {
        detail = `${item.exitCode === undefined || item.exitCode === 0 ? 'Ran' : `Exit ${item.exitCode}`} in ${duration(item.durationMs)}`
      }
      break
    case 'file':
      title = item.path ? basename(item.path) : 'A file'
      break
    case 'agent':
      title = item.subagent?.name ?? item.subagent?.description ?? 'Subagent'
      detail = item.subagent?.summary?.trim() || null
      break
    case 'thinking':
      // Named by its first line, as the desktop names a thought among calls.
      title = thoughtHeadline(item.text) || 'Thinking'
      detail = item.text?.trim() || null
      break
    case 'plan':
      title = 'Updated the plan'
      break
    default:
      title = toolTitle(item.text) ?? 'Tool'
  }
  return {
    id: item.id,
    kind,
    title,
    detail,
    added: kind === 'file' ? (item.linesAdded ?? null) : null,
    removed: kind === 'file' ? (item.linesRemoved ?? null) : null,
    running: item.status === 'started',
    failed: failed(item),
  }
}

/** What finished work did, in one sentence: "Edited 2 files and ran 3 commands". */
export function summarize(items: readonly Item[]): string {
  const files = new Set<string>()
  const read = new Set<string>()
  let commands = 0
  let tools = 0
  let thoughts = 0
  for (const item of items) {
    if (item.type === 'command') commands += 1
    else if (item.type === 'file_change') files.add(item.path ?? item.id)
    else if (item.type === 'tool_call' && isRead(item.text))
      read.add(toolTitle(item.text) ?? item.id)
    else if (item.type === 'tool_call') tools += 1
    else if (item.type === 'reasoning') thoughts += 1
  }
  const parts = [
    files.size ? `edited ${count(files.size, 'file')}` : '',
    commands ? `ran ${count(commands, 'command')}` : '',
    read.size ? `read ${count(read.size, 'file')}` : '',
    tools ? `used ${count(tools, 'tool')}` : '',
  ].filter(Boolean)
  if (parts.length === 0) return thoughts ? 'Thought it through' : count(items.length, 'step')
  const last = parts.pop()
  const sentence = parts.length > 0 ? `${parts.join(', ')} and ${last}` : (last ?? '')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** A thought's first line as plain text, its Markdown marks dropped. */
function thoughtHeadline(text: string | undefined): string {
  const line = text?.split('\n').find((entry) => entry.trim()) ?? ''
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A tool that reads one file: `Read`, `read_file`, `view_file`. */
function isRead(text: string | undefined): boolean {
  const head = text?.trim().split('\n', 1)[0]?.trim() ?? ''
  return /^(?:read|read[_ ]?file|view[_ ]?file)$/i.test(head)
}

/** Work under way names its latest step: "Running npm test", "Editing App.tsx". */
function liveSummary(items: readonly Item[]): string {
  const latest = items.at(-1)
  if (!latest) return 'Working'
  switch (latest.type) {
    case 'command':
      return `Running ${firstLine(latest.command ?? latest.text ?? 'a command')}`
    case 'file_change':
      return `Editing ${latest.path ? basename(latest.path) : 'a file'}`
    case 'reasoning':
      return 'Thinking'
    case 'tool_call':
      return latest.subagent
        ? `Working with ${latest.subagent.name ?? 'a subagent'}`
        : (toolTitle(latest.text) ?? 'Using a tool')
    default:
      return 'Working'
  }
}

/**
 * A tool call's text is its name on the first line, then optionally its
 * arguments as one JSON value, then its output (every adapter writes it that
 * way). The title is the name and the thing it acted on: "Read README.md".
 */
export function toolTitle(text: string | undefined): string | undefined {
  const source = text?.trim()
  if (!source) return undefined
  const newline = source.indexOf('\n')
  const head = (newline === -1 ? source : source.slice(0, newline)).trim()
  const inline = head.search(/\s[[{]/)
  const name = toolName(inline > 0 ? head.slice(0, inline) : head)
  const target = inline > 0 ? undefined : argumentTarget(source.slice(newline + 1))
  return target ? `${name} ${target}` : name
}

const TARGET_KEYS = ['file_path', 'path', 'query', 'pattern', 'url', 'command', 'description']

function argumentTarget(rest: string): string | undefined {
  const start = rest.search(/\S/)
  if (start === -1 || rest[start] !== '{') return undefined
  const end = jsonEnd(rest, start)
  if (end === undefined) return undefined
  let args: unknown
  try {
    args = JSON.parse(rest.slice(start, end))
  } catch {
    return undefined
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  const value = TARGET_KEYS.map((key) => record[key]).find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  )
  if (!value) return undefined
  const line = value.replace(/\s+/g, ' ').trim()
  // A path reads as the file it names; the folders are in the approval and the diff.
  const shown = /^[^\s]*[\\/][^\s]*$/.test(line) ? basename(line) : line
  return shown.length > 60 ? `${shown.slice(0, 59).trimEnd()}…` : shown
}

/** Where the JSON object opening at `start` closes, minding strings. */
function jsonEnd(text: string, start: number): number | undefined {
  let depth = 0
  let quoted = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '\\') index += 1
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

/**
 * A tool reported by its identifier reads as words: `AskUserQuestion` and
 * `web_search` become "Ask user question" and "Web search". Anything already
 * written as a phrase is left alone.
 */
export function toolName(text: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:[_-]+[A-Za-z0-9]+)*$/.test(text)) return text
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((word) => (/^[A-Z0-9]+$/.test(word) && word.length > 1 ? word : word.toLowerCase()))
  const sentence = words.join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

const PROVIDER_NAMES = new Map<ProviderId, string>([
  ['codex', 'Codex'],
  ['claude-code', 'Claude Code'],
  ['grok', 'Grok'],
  ['cursor', 'Cursor'],
  ['opencode', 'OpenCode'],
  ['antigravity', 'Antigravity'],
  ['pi', 'Pi'],
  ['acp', 'Agent'],
  ['api', 'API'],
])

function noticeText(item: Item): string {
  const notice = item.notice
  if (!notice) return firstLine(item.text ?? '')
  const name = PROVIDER_NAMES.get(notice.provider) ?? notice.provider
  return `Continued with ${name}${notice.model ? ` · ${notice.model}` : ''}`
}

export function approvalView(request: ApprovalRequest, projectPath: string | null): ApprovalView {
  const title =
    request.kind === 'command'
      ? 'Run this command?'
      : request.kind === 'file_change'
        ? 'Change this file?'
        : 'Allow this access?'
  const subject =
    request.kind === 'file_change' && request.path
      ? relative(request.path, projectPath)
      : (request.command ?? request.path ?? null)
  const cwd = request.cwd ? relative(request.cwd, projectPath) : null
  const reason = request.reason?.trim()
  return {
    id: request.id,
    title,
    subject,
    // Some engines give the file's name as the reason; it says nothing the subject does not.
    reason: reason && reason !== subject && !subject?.endsWith(reason) ? reason : null,
    where: cwd && cwd !== '.' ? cwd : null,
  }
}

export function questionsView(request: UserInputRequest): QuestionsView {
  return {
    id: request.id,
    questions: request.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        detail: option.description,
      })),
      multiple: question.multiSelect ?? false,
      other: question.allowOther || !question.options?.length,
      secret: question.secret,
    })),
  }
}

/** A path inside the project, written from the project's folder; anything else stays whole. */
export function relative(path: string, root: string | null): string {
  if (!root) return path
  // macOS reports /tmp and /var through their /private targets.
  const plain = (value: string) => value.replace(/^\/private(?=\/(?:tmp|var)\/)/, '')
  const target = plain(path)
  const base = plain(root).replace(/[\\/]+$/, '')
  if (target === base) return '.'
  for (const separator of ['/', '\\']) {
    if (target.startsWith(base + separator)) return target.slice(base.length + 1)
  }
  return path
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
