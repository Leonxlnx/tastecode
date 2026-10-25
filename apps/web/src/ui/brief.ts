import type { ApprovalRequest, Item, PlanStep, UserInputRequest } from '@harness/contracts'
import type { ThreadState } from '../thread-state.js'
import { parseToolCall, toolArgumentSnippet } from './tool-call-text.js'
import { isBlankReasoning, projectThreadItems, type TurnPresentation } from './turns.js'

/**
 * The Brief: a page of what is true in a chat now, written by TasteCode from
 * the chat's own items rather than from anything the agent says about itself.
 * Everything here is derived from the provider-neutral contract (prompts,
 * plan updates, file changes, commands with exit codes, approvals, questions,
 * answers), so every provider gets the same page and nothing branches on a
 * provider's name.
 *
 * Deriving walks the loaded transcript once. It never runs per streamed text
 * update: the view feeds it structural snapshots, at most every 500 ms while a
 * turn runs, and per-item diff parsing is cached on the immutable item.
 */

export type BriefSource = Pick<
  ThreadState,
  | 'items'
  | 'turnTiming'
  | 'plan'
  | 'running'
  | 'activeTurn'
  | 'approvals'
  | 'userInputs'
  | 'error'
  | 'olderCursor'
>

export type BriefOptions = {
  /** Absolute project folder; paths under it read project-relative. */
  projectPath?: string | undefined
  /** Show the brief as it stood after this turn (1-based). Undefined: now. */
  asOfTurn?: number | undefined
}

export type BriefTurnState = 'done' | 'running' | 'stopped' | 'failed'

export type BriefTurn = {
  id: string
  /** 1-based among the loaded turns. */
  number: number
  /** The prompt's text, whole. Empty when the turn has none loaded. */
  prompt: string
  startedAt: number
  endedAt: number | undefined
  state: BriefTurnState
  /** The prompt item, which names the checkpoint taken before the turn. */
  promptItem: Item | undefined
}

export type BriefAsk =
  | {
      kind: 'approval'
      id: string
      /** What would run or change, in a few words. */
      title: string
      command: string | undefined
      path: string | undefined
      cwd: string | undefined
      reason: string | undefined
      at: number
    }
  | {
      kind: 'question'
      id: string
      header: string
      question: string
      options: string[]
      /** Further questions in the same request. */
      more: number
      secret: boolean
      at: number
    }

export type BriefStopped = {
  kind: 'failed' | 'stopped'
  /** The failure's first line; undefined when the user stopped the turn. */
  message: string | undefined
  turn: number
  /** How long the turn ran before it ended, when known. */
  ranMs: number | undefined
  /** Plan progress at the stop, as "step 3 of 4". */
  step: { index: number; count: number } | undefined
}

export type BriefNow = {
  verb: string
  object: string | undefined
  /** The object is a command line, set in mono. */
  command: boolean
  startedAt: number
  step: { index: number; count: number } | undefined
  /** The agent's latest finished note in this turn, first paragraph. */
  note: string | undefined
}

export type BriefPlan = {
  turn: number
  steps: PlanStep[]
  done: number
  /**
   * `shared`: the steps are the turn's latest plan. `none`: the turn ran
   * without one. `not-kept`: an earlier turn, whose plan the chat no longer
   * holds (only the latest turn's plan is kept).
   */
  status: 'shared' | 'none' | 'not-kept'
}

export type BriefFile = {
  /** Identity across turns: the normalized absolute or relative path. */
  key: string
  /** The path as the item named it, for Review. */
  path: string
  /** Project-relative directory with its trailing slash, or ''. */
  directory: string
  name: string
  added: number
  removed: number
  /** Turn numbers that changed it, ascending. */
  turns: number[]
  deleted: boolean
}

export type BriefChanges = {
  files: BriefFile[]
  added: number
  removed: number
}

export type BriefCheckKind = 'test' | 'typecheck' | 'lint' | 'build'

export type BriefCheck = {
  kind: BriefCheckKind
  label: string
  /** The command as it ran, shell wrapper and leading absolute cd removed. */
  command: string
  /**
   * `passed` and `failed` read the exit code; `running` has none yet;
   * `ended` finished without one; `pending` failed while its turn still
   * runs, which is routine (a test that fails before it is fixed).
   */
  state: 'passed' | 'failed' | 'running' | 'ended' | 'pending'
  /** "42 passed", "no errors", "exit 1". */
  result: string
  exitCode: number | undefined
  durationMs: number | undefined
  turn: number
  at: number
  /** The command ran other checks too, so one exit code covers them all. */
  chained: boolean
}

export type BriefAnswer = {
  text: string
  turn: number
  at: number
  /** How long its turn worked. */
  workedMs: number | undefined
  /** The turn stopped while this text was being written. */
  partial: boolean
}

export type Brief = {
  turns: BriefTurn[]
  /** The turn the page shows as of; undefined for now. */
  asOf: BriefTurn | undefined
  /** Older turns are not loaded, so turn numbers start at the oldest loaded one. */
  partial: boolean
  running: boolean
  needsYou: BriefAsk[]
  stopped: BriefStopped | undefined
  asked: { latest: BriefTurn; earlier: BriefTurn[] } | undefined
  now: BriefNow | undefined
  /** Undefined for a chat that only talked: no plan, no change, no check. */
  plan: BriefPlan | undefined
  changes: BriefChanges
  checks: BriefCheck[]
  /** Check kinds this chat never ran, once at least one check ran. */
  notRun: BriefCheckKind[]
  answer: BriefAnswer | undefined
  /** The latest turn is running and has not answered yet. */
  answerPending: boolean
  /** Commands the shown range ran, for the quiet line of a talk-only chat. */
  commandCount: number
}

export const CHECK_KINDS: readonly BriefCheckKind[] = ['test', 'typecheck', 'lint', 'build']

export const CHECK_LABELS = {
  test: 'Tests',
  typecheck: 'Types',
  lint: 'Lint',
  build: 'Build',
} as const satisfies Record<BriefCheckKind, string>

const EMPTY: readonly never[] = []

export function deriveBrief(source: BriefSource, options: BriefOptions = {}): Brief {
  const items = source.items
  const projection = projectThreadItems(items as Item[], source.turnTiming, source.activeTurn?.id)
  const turns: BriefTurn[] = []
  const byId = new Map<string, BriefTurn>()
  /** Flat index where each turn starts, for the as-of cut. */
  const starts: number[] = []
  /** The turn every flat index belongs to; rows outside a turn join the one before. */
  const owner: Array<BriefTurn | undefined> = Array.from({ length: items.length })
  const erroredTurns = new Set<BriefTurn>()
  let current: BriefTurn | undefined

  for (const mark of projection.turns) {
    const first = items[mark.index]
    const local = mark.turnId.startsWith('local:')
    let turn = local ? undefined : byId.get(mark.turnId)
    if (!turn && (!local || isUserPrompt(first))) {
      const presentation = local ? undefined : projection.presentations.get(mark.turnId)
      turn = createTurn(source, mark.turnId, turns.length + 1, first, presentation, local)
      turns.push(turn)
      starts.push(mark.index)
      if (!local) byId.set(mark.turnId, turn)
    }
    current = turn ?? current
    for (let index = mark.index; index < mark.index + mark.count; index += 1) {
      owner[index] = current
      if (items[index]?.type === 'error' && current) erroredTurns.add(current)
    }
  }

  const lastTurn = turns.at(-1)
  for (const turn of erroredTurns) {
    if (turn.state === 'done') turn.state = 'failed'
  }
  if (lastTurn && source.error && !source.running && lastTurn.state === 'done') {
    lastTurn.state = 'failed'
  }

  const requested = options.asOfTurn
  const asOf =
    requested !== undefined && requested >= 1 && requested < turns.length
      ? turns[requested - 1]
      : undefined
  const cut = asOf ? (starts[asOf.number] ?? items.length) : items.length
  const shown = asOf ? turns.slice(0, asOf.number) : turns
  const running = !asOf && source.running
  const latest = shown.at(-1)

  const walk = walkItems(items, owner, cut, options.projectPath, running ? latest : undefined)

  const plan = briefPlan(source, latest, asOf, walk, running)
  const presentation = latest ? projection.presentations.get(latest.id) : undefined

  return {
    turns,
    asOf,
    partial: Boolean(source.olderCursor),
    running,
    needsYou: asOf ? [] : asks(source.approvals, source.userInputs, options.projectPath),
    stopped: latest
      ? stoppedFor(latest, asOf ? undefined : source.error, items, owner, cut, plan)
      : undefined,
    asked: latest
      ? {
          latest,
          earlier: shown
            .slice(0, -1)
            .reverse()
            .filter((turn) => turn.prompt),
        }
      : undefined,
    now: running && latest ? nowFor(source, latest, walk, plan, options.projectPath) : undefined,
    plan,
    changes: walk.changes,
    checks: walk.checks,
    notRun:
      walk.checks.length > 0
        ? CHECK_KINDS.filter((kind) => !walk.checks.some((check) => check.kind === kind))
        : [],
    answer: answerFor(shown, projection.presentations),
    answerPending: running && Boolean(latest) && !presentation?.responseText,
    commandCount: walk.commandCount,
  }
}

function isUserPrompt(item: Item | undefined): boolean {
  return item?.type === 'message' && item.role === 'user'
}

function createTurn(
  source: BriefSource,
  id: string,
  number: number,
  first: Item | undefined,
  presentation: TurnPresentation | undefined,
  local: boolean,
): BriefTurn {
  const promptItem = presentation?.prompt ?? (isUserPrompt(first) ? first : undefined)
  const timing = local ? undefined : source.turnTiming[id]
  const startedAt = timing?.startedAt ?? promptItem?.createdAt ?? first?.createdAt ?? 0
  const live = source.running && (local || id === source.activeTurn?.id)
  const state: BriefTurnState = live ? 'running' : presentation?.stopped ? 'stopped' : 'done'
  return {
    id,
    number,
    prompt: promptItem?.text?.trim() ?? '',
    startedAt,
    endedAt:
      state === 'running'
        ? undefined
        : (timing?.completedAt ?? (presentation ? startedAt + presentation.elapsedMs : undefined)),
    state,
    promptItem,
  }
}

// ---------- one pass over the shown items ----------

type Walk = {
  changes: BriefChanges
  checks: BriefCheck[]
  commandCount: number
  /** The live turn's newest started activity and newest finished note. */
  live: { activity: Item | undefined; note: Item | undefined; streaming: Item | undefined }
}

function walkItems(
  items: readonly Item[],
  owner: ReadonlyArray<BriefTurn | undefined>,
  cut: number,
  projectPath: string | undefined,
  liveTurn: BriefTurn | undefined,
): Walk {
  const files = new Map<string, BriefFile>()
  const latestCheck = new Map<BriefCheckKind, { item: Item; turn: BriefTurn; chained: boolean }>()
  let commandCount = 0
  const live: Walk['live'] = { activity: undefined, note: undefined, streaming: undefined }

  for (let index = 0; index < cut; index += 1) {
    const item = items[index]!
    const turn = owner[index]
    if (!turn) continue

    if (item.type === 'file_change' && item.status === 'completed') {
      for (const delta of fileDeltas(item)) {
        const key = pathKey(delta.path)
        let file = files.get(key)
        if (!file) {
          const relative = projectRelativePath(delta.path, projectPath)
          const slash = relative.lastIndexOf('/')
          file = {
            key,
            path: delta.path,
            directory: slash >= 0 ? relative.slice(0, slash + 1) : '',
            name: slash >= 0 ? relative.slice(slash + 1) : relative,
            added: 0,
            removed: 0,
            turns: [],
            deleted: false,
          }
          files.set(key, file)
        }
        file.added += delta.added
        file.removed += delta.removed
        file.deleted = delta.deleted
        if (file.turns.at(-1) !== turn.number) file.turns.push(turn.number)
      }
    }

    if (item.type === 'command') {
      commandCount += 1
      const kinds = checkKinds(item.command)
      for (const kind of kinds) {
        latestCheck.set(kind, { item, turn, chained: kinds.length > 1 })
      }
    }

    if (liveTurn && turn === liveTurn) {
      if (
        item.status === 'started' &&
        (item.type === 'command' || item.type === 'file_change' || item.type === 'tool_call')
      ) {
        live.activity = item
      } else if (item.type === 'reasoning' && item.status === 'started' && !live.activity) {
        live.activity = item
      }
      if (item.type === 'message' && item.role === 'assistant') {
        if (item.status === 'completed' && item.phase !== 'final_answer' && item.text?.trim()) {
          live.note = item
        }
        live.streaming = item.status === 'started' ? item : undefined
      } else if (item.type !== 'message' && !isBlankReasoning(item)) {
        live.streaming = undefined
      }
    }
  }

  const fileList = [...files.values()]
  let added = 0
  let removed = 0
  for (const file of fileList) {
    added += file.added
    removed += file.removed
  }

  const checks: BriefCheck[] = []
  for (const kind of CHECK_KINDS) {
    const entry = latestCheck.get(kind)
    if (!entry) continue
    checks.push(checkFor(kind, entry.item, entry.turn, entry.chained))
  }

  return { changes: { files: fileList, added, removed }, checks, commandCount, live }
}

// ---------- plan, now, stop, answer ----------

function briefPlan(
  source: BriefSource,
  latest: BriefTurn | undefined,
  asOf: BriefTurn | undefined,
  walk: Walk,
  running: boolean,
): BriefPlan | undefined {
  if (!latest) return undefined
  // The chat holds one plan: the latest turn's (the reducer clears it when a
  // turn starts, and a reopened chat replays only the last one).
  const steps = asOf ? EMPTY : source.plan
  const talkOnly = steps.length === 0 && walk.changes.files.length === 0 && walk.checks.length === 0
  if (talkOnly && !running) return undefined
  return {
    turn: latest.number,
    steps: [...steps],
    done: steps.filter((step) => step.status === 'done').length,
    status: steps.length > 0 ? 'shared' : asOf ? 'not-kept' : 'none',
  }
}

function planStep(plan: BriefPlan | undefined): BriefNow['step'] {
  if (!plan || plan.steps.length === 0) return undefined
  const running = plan.steps.findIndex((step) => step.status === 'running')
  const index = running >= 0 ? running : plan.steps.findIndex((step) => step.status === 'pending')
  return index >= 0 ? { index: index + 1, count: plan.steps.length } : undefined
}

function nowFor(
  source: BriefSource,
  turn: BriefTurn,
  walk: Walk,
  plan: BriefPlan | undefined,
  projectPath: string | undefined,
): BriefNow {
  const { activity, note, streaming } = walk.live
  let verb = 'Thinking'
  let object: string | undefined
  let command = false
  if (source.approvals.length > 0 || source.userInputs.length > 0) {
    verb = 'Waiting for you'
  } else if (activity?.type === 'command') {
    verb = 'Running'
    object = displayCommand(activity.command) || undefined
    command = object !== undefined
  } else if (activity?.type === 'file_change') {
    verb = 'Editing'
    object = activity.path ? relativeDisplay(activity.path, projectPath) : undefined
  } else if (activity?.type === 'tool_call') {
    const call = parseToolCall(activity.text)
    const name = call.name.toLowerCase()
    const snippet = toolArgumentSnippet(call.args, 60)
    verb = /search|grep|glob|find/.test(name)
      ? 'Searching'
      : /read|open|view|cat|list/.test(name)
        ? 'Reading'
        : `Using ${call.name || 'a tool'}`
    object = snippet
  } else if (streaming) {
    verb = streaming.phase === 'final_answer' ? 'Writing the answer' : 'Writing'
  }
  return {
    verb,
    object,
    command,
    startedAt: source.activeTurn?.startedAt ?? turn.startedAt,
    step: planStep(plan),
    note: note?.text ? firstParagraph(note.text) : undefined,
  }
}

function stoppedFor(
  turn: BriefTurn,
  error: BriefSource['error'],
  items: readonly Item[],
  owner: ReadonlyArray<BriefTurn | undefined>,
  cut: number,
  plan: BriefPlan | undefined,
): BriefStopped | undefined {
  if (turn.state !== 'failed' && turn.state !== 'stopped') return undefined
  let message = error?.message
  if (turn.state === 'failed' && !message) {
    for (let index = cut - 1; index >= 0; index -= 1) {
      if (owner[index] !== turn) break
      const item = items[index]!
      if (item.type === 'error') {
        message = item.text
        break
      }
    }
  }
  return {
    kind: turn.state === 'failed' ? 'failed' : 'stopped',
    message: turn.state === 'failed' ? firstLine(message ?? 'The turn failed') : undefined,
    turn: turn.number,
    ranMs: turn.endedAt !== undefined ? Math.max(0, turn.endedAt - turn.startedAt) : undefined,
    step: plan?.status === 'shared' ? planStep(plan) : undefined,
  }
}

function answerFor(
  shown: readonly BriefTurn[],
  presentations: ReadonlyMap<string, TurnPresentation>,
): BriefAnswer | undefined {
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const turn = shown[index]!
    const presentation = presentations.get(turn.id)
    const text = presentation?.responseText?.trim()
    if (!presentation || !text) continue
    return {
      text,
      turn: turn.number,
      at: turn.endedAt ?? turn.startedAt,
      workedMs: presentation.complete ? presentation.elapsedMs : undefined,
      partial: presentation.stopped,
    }
  }
  return undefined
}

function asks(
  approvals: readonly ApprovalRequest[],
  questions: readonly UserInputRequest[],
  projectPath: string | undefined,
): BriefAsk[] {
  const result: BriefAsk[] = []
  for (const approval of approvals) {
    const command = approval.command ? displayCommand(approval.command) : undefined
    const path = approval.path ? relativeDisplay(approval.path, projectPath) : undefined
    result.push({
      kind: 'approval',
      id: approval.id,
      title:
        approval.kind === 'command'
          ? 'Run a command'
          : approval.kind === 'file_change'
            ? path
              ? 'Change a file'
              : 'Change files'
            : 'Grant access',
      command,
      path,
      cwd: approval.cwd ? relativeDisplay(approval.cwd, projectPath) || '.' : undefined,
      reason: approval.reason?.trim() || undefined,
      at: approval.createdAt,
    })
  }
  for (const request of questions) {
    const first = request.questions[0]
    if (!first) continue
    result.push({
      kind: 'question',
      id: request.id,
      header: first.header,
      question: first.question,
      options: first.secret ? [] : (first.options ?? []).map((option) => option.label),
      more: request.questions.length - 1,
      secret: first.secret,
      at: request.createdAt,
    })
  }
  return result.sort((left, right) => left.at - right.at)
}

// ---------- checks ----------

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx'])
const FLAG_WITH_VALUE = new Set([
  '--filter',
  '-f',
  '-c',
  '--dir',
  '--prefix',
  '-w',
  '--workspace',
  '--cwd',
])

/**
 * The check kinds a command line runs, recognised from its own words: the
 * tool or package script at the head of each step of the line. Reading a
 * test file (`cat x.test.ts`) or searching for a tool (`rg vitest`) is not
 * running it.
 */
export function checkKinds(command: string | undefined): BriefCheckKind[] {
  const line = displayCommand(command)
  if (!line) return []
  const kinds: BriefCheckKind[] = []
  for (const segment of line.split(/&&|\|\||[;|\n]/)) {
    const kind = segmentKind(tokenize(segment))
    if (kind && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

function tokenize(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^["']|["']$/g, ''),
  )
}

function toolName(token: string | undefined): string {
  if (!token) return ''
  const base = token.replace(/\\/g, '/').split('/').at(-1) ?? token
  return base.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, '')
}

function segmentKind(tokens: string[]): BriefCheckKind | undefined {
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
  if (toolName(tokens[index]) === 'cross-env') {
    index += 1
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
  }
  let name = toolName(tokens[index])
  let rest = tokens.slice(index + 1)

  if (PACKAGE_RUNNERS.has(name)) {
    rest = skipFlags(rest)
    name = toolName(rest[0])
    rest = rest.slice(1)
  } else if (PACKAGE_MANAGERS.has(name)) {
    rest = skipFlags(rest)
    const verb = rest[0]?.toLowerCase()
    if (verb === 'run' || verb === 'run-script') {
      return scriptKind(skipFlags(rest.slice(1))[0])
    }
    if (verb === 'test' || verb === 't') return 'test'
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') {
      rest = skipFlags(rest.slice(1))
      name = toolName(rest[0])
      rest = rest.slice(1)
    } else {
      // `pnpm lint` runs the package script; `pnpm vitest` runs the binary.
      const script = scriptKind(verb)
      if (script) return script
      name = toolName(rest[0])
      rest = rest.slice(1)
    }
  }
  if ((name === 'python' || name === 'python3' || name === 'py') && rest[0] === '-m') {
    name = toolName(rest[1])
    rest = rest.slice(2)
  } else if ((name === 'uv' || name === 'poetry' || name === 'pipenv') && rest[0] === 'run') {
    name = toolName(rest[1])
    rest = rest.slice(2)
  }
  return toolKind(
    name,
    rest.map((token) => token.toLowerCase()),
  )
}

function skipFlags(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    const flag = tokens[index]!.toLowerCase()
    index += FLAG_WITH_VALUE.has(flag) && !flag.includes('=') ? 2 : 1
  }
  return tokens.slice(index)
}

function scriptKind(script: string | undefined): BriefCheckKind | undefined {
  const name = script?.toLowerCase()
  if (!name) return undefined
  if (/(?:^|[:_-])(?:test|tests|spec|e2e|unit)(?:$|[:_-])/.test(name)) return 'test'
  if (/^(?:typecheck|type-check|check-types|types)(?:$|:)/.test(name)) return 'typecheck'
  if (/^(?:lint|eslint)(?:$|:)/.test(name)) return 'lint'
  if (/^(?:build|compile)(?:$|:)/.test(name)) return 'build'
  return undefined
}

const TEST_TOOLS = new Set(['vitest', 'jest', 'mocha', 'ava', 'pytest', 'phpunit', 'rspec'])
const TYPE_TOOLS = new Set(['vue-tsc', 'mypy', 'pyright', 'svelte-check'])
const LINT_TOOLS = new Set([
  'eslint',
  'oxlint',
  'ruff',
  'flake8',
  'pylint',
  'golangci-lint',
  'stylelint',
  'rubocop',
])
const BUILD_TOOLS = new Set(['webpack', 'rollup', 'esbuild', 'tsup', 'parcel'])
const SUBCOMMAND_TOOLS = new Set(['go', 'cargo', 'dotnet', 'swift', 'mix', 'deno', 'bun'])

function toolKind(name: string, args: string[]): BriefCheckKind | undefined {
  const first = args[0]
  if (name === 'vitest') return first === 'bench' ? undefined : 'test'
  if (TEST_TOOLS.has(name)) return 'test'
  if (name === 'playwright' && first === 'test') return 'test'
  if (name === 'cypress' && first === 'run') return 'test'
  if (name === 'node' && args.includes('--test')) return 'test'
  if (name === 'tsc') return args.includes('-b') || args.includes('--build') ? 'build' : 'typecheck'
  if (TYPE_TOOLS.has(name)) return 'typecheck'
  if (LINT_TOOLS.has(name)) return 'lint'
  if (name === 'biome' && (first === 'check' || first === 'lint' || first === 'ci')) return 'lint'
  if (name === 'prettier' && (args.includes('--check') || args.includes('-c'))) return 'lint'
  if (BUILD_TOOLS.has(name)) return 'build'
  if (
    (name === 'vite' || name === 'next' || name === 'nuxt' || name === 'astro') &&
    first === 'build'
  )
    return 'build'
  if (SUBCOMMAND_TOOLS.has(name)) {
    if (first === 'test') return 'test'
    if (first === 'check') return 'typecheck'
    if (first === 'clippy' || first === 'vet' || first === 'lint') return 'lint'
    if (first === 'build') return 'build'
  }
  if ((name === 'gradle' || name === 'gradlew' || name === 'mvn') && first) {
    if (first === 'test' || first === 'verify') return 'test'
    if (first === 'build' || first === 'assemble' || first === 'package') return 'build'
  }
  if (name === 'make') {
    if (first === 'test' || first === 'check') return 'test'
    if (first === 'lint') return 'lint'
    if (first === 'build' || first === undefined) return 'build'
  }
  return undefined
}

function checkFor(kind: BriefCheckKind, item: Item, turn: BriefTurn, chained: boolean): BriefCheck {
  const running = item.status === 'started'
  const failed = item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)
  const passed = !failed && item.exitCode === 0
  const turnLive = turn.state === 'running'
  const state: BriefCheck['state'] = running
    ? 'running'
    : failed
      ? turnLive
        ? 'pending'
        : 'failed'
      : passed
        ? 'passed'
        : 'ended'
  return {
    kind,
    label: CHECK_LABELS[kind],
    command: displayCommand(item.command),
    state,
    result: running ? 'running' : checkResult(kind, item, passed, failed),
    exitCode: item.exitCode,
    durationMs: item.durationMs,
    turn: turn.number,
    at: item.createdAt,
    chained,
  }
}

const OUTPUT_TAIL = 4000

function checkResult(kind: BriefCheckKind, item: Item, passed: boolean, failed: boolean): string {
  const output = (item.text ?? '').slice(-OUTPUT_TAIL)
  if (kind === 'test') {
    const counts = testCounts(output)
    if (counts) {
      return counts.failed
        ? `${counts.failed} failed${counts.passed ? ` · ${counts.passed} passed` : ''}`
        : `${counts.passed} passed`
    }
  }
  if (kind === 'typecheck' && failed) {
    const found = /Found (\d+) errors?/.exec(output)
    if (found) return `${found[1]} ${found[1] === '1' ? 'error' : 'errors'}`
  }
  if (kind === 'lint' && failed) {
    const problems = /(\d+) problems? \(/.exec(output)
    if (problems) return `${problems[1]} ${problems[1] === '1' ? 'problem' : 'problems'}`
  }
  if (passed) {
    return kind === 'typecheck'
      ? 'no errors'
      : kind === 'lint'
        ? 'clean'
        : kind === 'build'
          ? 'built'
          : 'passed'
  }
  if (failed) return item.exitCode !== undefined ? `exit ${item.exitCode}` : 'failed'
  return 'finished'
}

/**
 * A test runner's own summary line: vitest and jest ("Tests  1 failed | 41
 * passed", "Tests: 41 passed, 41 total"), pytest ("== 41 passed in 3.1s =="),
 * mocha ("41 passing", "1 failing"). The last one in the output wins.
 */
export function testCounts(output: string): { passed: number; failed: number } | undefined {
  const lines = output.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (/^\s*Tests:?\s/.test(line) || /^=+ .*\bin [\d.]+s\b/.test(line)) {
      const passed = /(\d+) passed/.exec(line)
      const failed = /(\d+) failed/.exec(line)
      if (passed || failed)
        return { passed: Number(passed?.[1] ?? 0), failed: Number(failed?.[1] ?? 0) }
    }
  }
  const passing = /(\d+) passing\b/.exec(output)
  if (passing) {
    const failing = /(\d+) failing\b/.exec(output)
    return { passed: Number(passing[1]), failed: Number(failing?.[1] ?? 0) }
  }
  return undefined
}

// ---------- commands and paths ----------

const SHELL_WRAPPER =
  /^(?:"(?:[^"]*[\\/])?(?:ba|z)?sh(?:\.exe)?"|(?:\S*[\\/])?(?:ba|z)?sh(?:\.exe)?) -l?c (['"])([\s\S]*)\1$/
const POWERSHELL_WRAPPER =
  /^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)(?:\s+-\w+)*?\s+-(?:Command|c)\s+([\s\S]+)$/i
const CMD_WRAPPER = /^(?:"[^"]*cmd(?:\.exe)?"|\S*cmd(?:\.exe)?)\s+\/[cs]\s+([\s\S]+)$/i
const LEADING_ABSOLUTE_CD =
  /^cd(?:\s+\/d)?\s+(?:"(?:[a-z]:|[\\/~])[^"]*"|'(?:[a-z]:|[\\/~])[^']*'|(?:[a-z]:|[\\/~])[^\s;&|]*)\s*(?:&&|;)\s*/i

/**
 * The command a row names: Codex runs every command through a login shell
 * and Claude Code often starts with `cd "<project>" &&`; the part that does
 * the work is what reads.
 */
export function displayCommand(command: string | undefined): string {
  let text = command?.replace(/\s+/g, ' ').trim() ?? ''
  for (let depth = 0; depth < 2; depth += 1) {
    const shell = SHELL_WRAPPER.exec(text)
    const powershell = shell ? undefined : POWERSHELL_WRAPPER.exec(text)
    const cmd = shell || powershell ? undefined : CMD_WRAPPER.exec(text)
    const inner = shell?.[2] ?? powershell?.[1] ?? cmd?.[1]
    if (!inner) break
    text = inner
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2')
      .trim()
  }
  return text.replace(LEADING_ABSOLUTE_CD, '') || text
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

function pathKey(path: string): string {
  const normalized = normalizedPath(path).replace(/^\.\//, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

/**
 * A path the way a person in the project says it: relative to the project
 * folder, with forward slashes. A path outside the project keeps its last
 * three parts.
 */
export function projectRelativePath(path: string, projectPath: string | undefined): string {
  const normalized = normalizedPath(path).replace(/^\.\//, '')
  if (projectPath) {
    const root = normalizedPath(projectPath).replace(/\/+$/, '')
    const windows = /^[a-z]:\//i.test(root)
    const head = normalized.slice(0, root.length + 1)
    if (
      normalized.length > root.length + 1 &&
      (windows ? head.toLowerCase() === `${root.toLowerCase()}/` : head === `${root}/`)
    ) {
      return normalized.slice(root.length + 1)
    }
  }
  if (/^(?:[a-z]:\/|\/)/i.test(normalized)) {
    const parts = normalized.split('/').filter(Boolean)
    return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : normalized
  }
  return normalized
}

function relativeDisplay(path: string, projectPath: string | undefined): string {
  const relative = projectRelativePath(path, projectPath)
  return relative === normalizedPath(projectPath ?? '').replace(/\/+$/, '') ? '' : relative
}

// ---------- file changes ----------

type FileDelta = { path: string; added: number; removed: number; deleted: boolean }
const deltaCache = new WeakMap<Item, FileDelta[]>()
const DIFF_START = /^(?:diff --git |--- |@@ )/m

/**
 * The files one file_change item touched, with line counts. A Codex patch can
 * span several files in one item; the counts then come from its diff. Cached
 * on the item, which never changes once it completed.
 */
export function fileDeltas(item: Item): FileDelta[] {
  const cached = deltaCache.get(item)
  if (cached) return cached
  const text = item.text ?? ''
  const headers = text.match(/^diff --git /gm)?.length ?? 0
  let deltas: FileDelta[]
  if (headers <= 1 && item.path) {
    let added = item.linesAdded
    let removed = item.linesRemoved
    const diff = DIFF_START.test(text) ? parseDiffFiles(text, item.path) : undefined
    if (added === undefined && removed === undefined && diff?.[0]) {
      added = diff[0].added
      removed = diff[0].removed
    }
    deltas = [
      {
        path: item.path,
        added: added ?? 0,
        removed: removed ?? 0,
        deleted: diff?.[0]?.deleted ?? false,
      },
    ]
  } else if (DIFF_START.test(text)) {
    deltas = parseDiffFiles(text, item.path)
  } else {
    deltas = item.path
      ? [
          {
            path: item.path,
            added: item.linesAdded ?? 0,
            removed: item.linesRemoved ?? 0,
            deleted: false,
          },
        ]
      : []
  }
  if (item.status === 'completed') deltaCache.set(item, deltas)
  return deltas
}

function parseDiffFiles(text: string, fallbackPath: string | undefined): FileDelta[] {
  const files: FileDelta[] = []
  let current: FileDelta | undefined
  let inHunk = false
  const start = (path: string) => {
    current = { path, added: 0, removed: 0, deleted: false }
    files.push(current)
    inHunk = false
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const marker = line.lastIndexOf(' b/')
      start(marker >= 0 ? line.slice(marker + 3) : (fallbackPath ?? 'Changes'))
    } else if (!inHunk && line.startsWith('+++ ')) {
      if (!current) start(fallbackPath ?? 'Changes')
      const destination = line.slice(4).trim().replace(/^"|"$/g, '')
      if (destination === '/dev/null') current!.deleted = true
      else current!.path = destination.replace(/^b\//, '')
    } else if (!inHunk && line.startsWith('--- ')) {
      if (!current) start(fallbackPath ?? 'Changes')
    } else if (line.startsWith('@@')) {
      if (!current) start(fallbackPath ?? 'Changes')
      inHunk = true
    } else if (inHunk && line.startsWith('+')) {
      current!.added += 1
    } else if (inHunk && line.startsWith('-')) {
      current!.removed += 1
    }
  }
  return files
}

// ---------- text ----------

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line.length > 240 ? `${line.slice(0, 239).trimEnd()}…` : line
}

function firstParagraph(text: string): string {
  const paragraph =
    text
      .trim()
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? ''
  return paragraph.length > 280 ? `${paragraph.slice(0, 279).trimEnd()}…` : paragraph
}

/** "turn 2", "turns 2 · 3", "turns 4–9 · 12". */
export function turnsLabel(turns: readonly number[]): string {
  if (turns.length === 0) return ''
  const runs: string[] = []
  let start = turns[0]!
  let previous = start
  for (const turn of [...turns.slice(1), Number.NaN]) {
    if (turn === previous + 1) {
      previous = turn
      continue
    }
    runs.push(
      start === previous
        ? `${start}`
        : previous === start + 1
          ? `${start} · ${previous}`
          : `${start}–${previous}`,
    )
    start = turn
    previous = turn
  }
  return `${turns.length === 1 ? 'turn' : 'turns'} ${runs.join(' · ')}`
}

/** "41s", "6m 48s", "1h 12m". */
export function briefDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "1:58", "12:04", "1:02:44": a running clock. */
export function briefClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const s = String(seconds % 60).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}:${s}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
}
