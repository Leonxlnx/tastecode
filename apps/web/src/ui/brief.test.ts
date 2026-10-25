import { describe, expect, it } from 'vitest'
import type { DomainEvent, Item, PlanStep } from '@harness/contracts'
import { emptyThread, reduceEventLog } from '../thread-store.js'
import {
  briefClock,
  briefDuration,
  checkKinds,
  deriveBrief,
  displayCommand,
  fileDeltas,
  projectRelativePath,
  testCounts,
  turnsLabel,
} from './brief.js'

const PROJECT = 'E:\\work\\payments-api'
const T0 = Date.UTC(2026, 9, 25, 11, 58)

type Step =
  | {
      kind: 'command'
      command: string
      exitCode?: number
      durationMs?: number
      output?: string
      open?: boolean
    }
  | { kind: 'edit'; path: string; added?: number; removed?: number; text?: string }
  | { kind: 'note'; text: string }
  | { kind: 'plan'; steps: PlanStep[] }
  | { kind: 'error'; text: string }
  | { kind: 'approval'; command: string }
  | { kind: 'question'; question: string; options: string[] }

type TurnSpec = {
  prompt: string
  steps?: Step[]
  answer?: string
  /** Leave the turn running: no answer, no turn.completed. */
  open?: boolean
  stopped?: boolean
}

/** Builds a chat the way the renderer does: through the reducer, from events. */
function chat(turns: TurnSpec[]) {
  const events: DomainEvent[] = []
  let clock = T0
  let n = 0
  const id = (prefix: string) => `${prefix}-${++n}`
  turns.forEach((turn, index) => {
    const turnId = `turn-${index + 1}`
    clock += 60_000
    events.push({
      type: 'turn.started',
      turn: { id: turnId, threadId: 't', status: 'running', createdAt: clock },
    })
    events.push({
      type: 'item.completed',
      item: {
        id: id('u'),
        turnId,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: turn.prompt,
        createdAt: clock,
      },
    })
    for (const step of turn.steps ?? []) {
      clock += 4_000
      const base = { id: id('i'), turnId, createdAt: clock }
      let item: Item | undefined
      if (step.kind === 'command') {
        item = {
          ...base,
          type: 'command',
          status: step.open ? 'started' : 'completed',
          command: step.command,
          ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
          ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
          ...(step.output === undefined ? {} : { text: step.output }),
        }
      } else if (step.kind === 'edit') {
        item = {
          ...base,
          type: 'file_change',
          status: 'completed',
          path: step.path,
          ...(step.text === undefined ? {} : { text: step.text }),
          ...(step.added === undefined ? {} : { linesAdded: step.added }),
          ...(step.removed === undefined ? {} : { linesRemoved: step.removed }),
        }
      } else if (step.kind === 'note') {
        item = {
          ...base,
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          status: 'completed',
          text: step.text,
        }
      } else if (step.kind === 'error') {
        item = { ...base, type: 'error', status: 'completed', text: step.text }
      } else if (step.kind === 'plan') {
        events.push({ type: 'plan.updated', turnId, steps: step.steps })
      } else if (step.kind === 'approval') {
        events.push({
          type: 'approval.requested',
          request: {
            id: id('a'),
            kind: 'command',
            command: step.command,
            cwd: PROJECT,
            reason: 'Apply the migration',
            createdAt: clock,
          },
        })
      } else if (step.kind === 'question') {
        events.push({
          type: 'user_input.requested',
          request: {
            id: id('q'),
            turnId,
            autoResolutionMs: null,
            createdAt: clock,
            questions: [
              {
                id: 'where',
                header: 'Query',
                question: step.question,
                allowOther: true,
                secret: false,
                options: step.options.map((label) => ({ label, description: label })),
              },
            ],
          },
        })
      }
      if (item) {
        events.push({ type: 'item.started', item: { ...item, status: 'started' } })
        if (item.status !== 'started') events.push({ type: 'item.completed', item })
      }
    }
    if (turn.open) return
    clock += 20_000
    if (turn.answer) {
      events.push({
        type: 'item.completed',
        item: {
          id: id('a'),
          turnId,
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          text: turn.answer,
          createdAt: clock,
        },
      })
    }
    events.push({
      type: 'turn.completed',
      turnId,
      status: turn.stopped ? 'interrupted' : 'completed',
      completedAt: clock + 1_000,
    })
  })
  return reduceEventLog(
    emptyThread,
    events.map((event, seq) => ({ seq, event })),
  )
}

const plan = (...steps: Array<[string, PlanStep['status']]>) =>
  ({ kind: 'plan', steps: steps.map(([text, status]) => ({ text, status })) }) as const

describe('deriveBrief: a Claude-like chat with a plan, commands and edits', () => {
  const state = chat([
    {
      prompt: 'Stripe sometimes charges a customer twice when it retries a webhook. Find out why.',
      steps: [
        {
          kind: 'command',
          command: `cd "${PROJECT}" && rg -n "seen\\(" src/webhooks`,
          exitCode: 0,
        },
        {
          kind: 'command',
          command: `cd "${PROJECT}" && pnpm vitest run src/webhooks`,
          exitCode: 1,
          durationMs: 2900,
          output: ' Test Files  1 failed | 3 passed\n      Tests  1 failed | 37 passed (38)\n',
        },
      ],
      answer: 'The handler charges before it records the event id.',
    },
    {
      prompt: 'Fix it: record the id before charging, and cover the race with a test.',
      steps: [
        plan(
          ['Move the id write into the charge transaction', 'done'],
          ['Write a test for two deliveries', 'done'],
        ),
        { kind: 'edit', path: `${PROJECT}\\src\\webhooks\\handler.ts`, added: 18, removed: 5 },
        { kind: 'edit', path: `${PROJECT}\\src\\webhooks\\handler.test.ts`, added: 41, removed: 0 },
        {
          kind: 'command',
          command: `cd "${PROJECT}" && pnpm vitest run src/webhooks`,
          exitCode: 0,
          durationMs: 3100,
          output: '      Tests  42 passed (42)\n',
        },
        {
          kind: 'command',
          command: `cd "${PROJECT}" && pnpm tsc --noEmit`,
          exitCode: 0,
          durationMs: 4100,
        },
      ],
      answer: 'Done. The id is written in the same transaction as the charge.',
    },
    {
      prompt: 'Now tidy the logging in the handler.',
      steps: [
        plan(
          ['Replace console calls with the structured logger', 'done'],
          ['Run the webhook suite', 'done'],
        ),
        { kind: 'edit', path: `${PROJECT}\\src\\webhooks\\handler.ts`, added: 9, removed: 7 },
        { kind: 'edit', path: `${PROJECT}\\src\\lib\\log.ts`, added: 3, removed: 1 },
      ],
      answer: 'The handler logs through the structured logger now.',
    },
  ])
  const brief = deriveBrief(state, { projectPath: PROJECT })

  it('lists every turn with its prompt', () => {
    expect(brief.turns.map((turn) => [turn.number, turn.state])).toEqual([
      [1, 'done'],
      [2, 'done'],
      [3, 'done'],
    ])
    expect(brief.asked?.latest.prompt).toBe('Now tidy the logging in the handler.')
    expect(brief.asked?.earlier.map((turn) => turn.number)).toEqual([2, 1])
  })

  it('sums every change since the chat began, by project-relative path and turn', () => {
    expect(
      brief.changes.files.map((file) => [
        file.directory + file.name,
        file.added,
        file.removed,
        file.turns,
      ]),
    ).toEqual([
      ['src/webhooks/handler.ts', 27, 12, [2, 3]],
      ['src/webhooks/handler.test.ts', 41, 0, [2]],
      ['src/lib/log.ts', 3, 1, [3]],
    ])
    expect([brief.changes.added, brief.changes.removed]).toEqual([71, 13])
  })

  it('keeps the latest run of each check, recognised from the command', () => {
    expect(
      brief.checks.map((check) => [
        check.label,
        check.state,
        check.result,
        check.turn,
        check.command,
      ]),
    ).toEqual([
      ['Tests', 'passed', '42 passed', 2, 'pnpm vitest run src/webhooks'],
      ['Types', 'passed', 'no errors', 2, 'pnpm tsc --noEmit'],
    ])
    expect(brief.notRun).toEqual(['lint', 'build'])
  })

  it('shows the latest turn plan and the last answer', () => {
    expect(brief.plan).toMatchObject({ turn: 3, status: 'shared', done: 2 })
    expect(brief.answer).toMatchObject({
      turn: 3,
      text: 'The handler logs through the structured logger now.',
    })
    expect(brief.now).toBeUndefined()
    expect(brief.stopped).toBeUndefined()
    expect(brief.needsYou).toEqual([])
  })

  it('reads the chat as it stood after an earlier turn', () => {
    const asOf = deriveBrief(state, { projectPath: PROJECT, asOfTurn: 2 })
    expect(asOf.asOf?.number).toBe(2)
    expect(asOf.turns).toHaveLength(3)
    expect(asOf.asked?.latest.number).toBe(2)
    expect(asOf.changes.files.map((file) => [file.name, file.added, file.turns])).toEqual([
      ['handler.ts', 18, [2]],
      ['handler.test.ts', 41, [2]],
    ])
    expect(asOf.plan).toMatchObject({ turn: 2, status: 'not-kept', steps: [] })
    expect(asOf.answer?.turn).toBe(2)
  })

  it('treats the last turn, or a turn out of range, as now', () => {
    expect(deriveBrief(state, { asOfTurn: 3 }).asOf).toBeUndefined()
    expect(deriveBrief(state, { asOfTurn: 9 }).asOf).toBeUndefined()
  })

  it('reads an earlier failing test run as failed once its turn ended', () => {
    const first = deriveBrief(state, { projectPath: PROJECT, asOfTurn: 1 })
    expect(first.checks).toMatchObject([
      { kind: 'test', state: 'failed', result: '1 failed · 37 passed' },
    ])
  })
})

describe('deriveBrief: a Codex-like chat', () => {
  const powershell = (command: string) =>
    `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${command}"`
  const patch = [
    'diff --git a/src/db/events.ts b/src/db/events.ts',
    '--- a/src/db/events.ts',
    '+++ b/src/db/events.ts',
    '@@ -1,2 +1,3 @@',
    ' import { db } from "./client"',
    '+export const unique = true',
    'diff --git a/db/migrations/0042.sql b/db/migrations/0042.sql',
    '--- /dev/null',
    '+++ b/db/migrations/0042.sql',
    '@@ -0,0 +1,2 @@',
    '+CREATE UNIQUE INDEX events_key',
    '+  ON events (stripe_event_id);',
    'diff --git a/src/old.ts b/src/old.ts',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-export {}',
  ].join('\n')
  const state = chat([
    {
      prompt: 'Add a unique index on stripe_event_id.',
      steps: [
        { kind: 'edit', path: 'src/db/events.ts', text: patch, added: 3, removed: 1 },
        {
          kind: 'command',
          command: powershell('pnpm lint && pnpm typecheck'),
          exitCode: 0,
          durationMs: 9000,
        },
        { kind: 'command', command: powershell('pnpm build'), exitCode: 2, output: 'error' },
      ],
      answer: 'Added the index.',
    },
  ])
  const brief = deriveBrief(state, { projectPath: PROJECT })

  it('splits a patch across files and marks a deleted file', () => {
    expect(
      brief.changes.files.map((file) => [
        file.directory + file.name,
        file.added,
        file.removed,
        file.deleted,
      ]),
    ).toEqual([
      ['src/db/events.ts', 1, 0, false],
      ['db/migrations/0042.sql', 2, 0, false],
      ['src/old.ts', 0, 1, true],
    ])
  })

  it('unwraps the shell and counts a chain once per check it ran', () => {
    expect(
      brief.checks.map((check) => [check.kind, check.state, check.chained, check.command]),
    ).toEqual([
      ['typecheck', 'passed', true, 'pnpm lint && pnpm typecheck'],
      ['lint', 'passed', true, 'pnpm lint && pnpm typecheck'],
      ['build', 'failed', false, 'pnpm build'],
    ])
    expect(brief.checks.find((check) => check.kind === 'build')?.result).toBe('exit 2')
    expect(brief.notRun).toEqual(['test'])
  })

  it('names the missing plan instead of hiding the section', () => {
    expect(brief.plan).toMatchObject({ turn: 1, status: 'none', steps: [] })
  })
})

describe('deriveBrief: Grok without a plan', () => {
  const state = chat([
    {
      prompt:
        'The Grok model list goes stale after a CLI update. Refresh it when the version changes.',
      steps: [
        { kind: 'note', text: 'Looking at how the model catalog is cached.' },
        {
          kind: 'edit',
          path: `${PROJECT}\\apps\\server\\src\\catalog-cache.ts`,
          text: '--- a/apps/server/src/catalog-cache.ts\n+++ b/apps/server/src/catalog-cache.ts\n@@ -1,2 +1,2 @@\n-const key = bin\n+const key = `${bin}@${version}`',
        },
      ],
      answer: 'The cache key now includes the CLI version.',
    },
  ])
  const brief = deriveBrief(state, { projectPath: PROJECT })

  it('counts lines from the diff when the item carries no counts', () => {
    expect(brief.changes.files).toMatchObject([
      { directory: 'apps/server/src/', name: 'catalog-cache.ts', added: 1, removed: 1, turns: [1] },
    ])
  })

  it('says the turn shared no plan and still lists changes and the answer', () => {
    expect(brief.plan).toMatchObject({ status: 'none' })
    expect(brief.checks).toEqual([])
    expect(brief.notRun).toEqual([])
    expect(brief.answer?.text).toBe('The cache key now includes the CLI version.')
  })
})

describe('deriveBrief: a direct API chat that only talks', () => {
  const state = chat([
    {
      prompt: 'How often do we rotate the Stripe signing secret?',
      answer: 'We do not rotate it on a schedule.',
    },
  ])
  const brief = deriveBrief(state, { projectPath: PROJECT })

  it('keeps to the ask and the answer', () => {
    expect(brief.plan).toBeUndefined()
    expect(brief.changes.files).toEqual([])
    expect(brief.checks).toEqual([])
    expect(brief.asked?.latest.prompt).toBe('How often do we rotate the Stripe signing secret?')
    expect(brief.asked?.earlier).toEqual([])
    expect(brief.answer).toMatchObject({ turn: 1, partial: false })
    expect(brief.commandCount).toBe(0)
  })
})

describe('deriveBrief: a failed turn', () => {
  const state = chat([
    {
      prompt: 'Move refunds into the ledger tables. Dry run first.',
      steps: [
        {
          kind: 'command',
          command: 'pnpm vitest run src/refunds',
          exitCode: 0,
          output: 'Tests  12 passed (12)',
        },
        {
          kind: 'error',
          text: 'Codex stopped: the stream disconnected before the turn finished.\nretry id 4471',
        },
      ],
    },
  ])
  const brief = deriveBrief(state, { projectPath: PROJECT })

  it('leads with what stopped, first line only', () => {
    expect(brief.turns[0]?.state).toBe('failed')
    expect(brief.stopped).toMatchObject({
      kind: 'failed',
      turn: 1,
      message: 'Codex stopped: the stream disconnected before the turn finished.',
    })
    expect(brief.answer).toBeUndefined()
  })

  it('reads a turn the user stopped as stopped, without an error', () => {
    const stopped = chat([{ prompt: 'Backfill 90 days.', answer: 'Backfilling', stopped: true }])
    expect(deriveBrief(stopped).stopped).toMatchObject({
      kind: 'stopped',
      message: undefined,
      turn: 1,
    })
  })

  it('does not keep a check running after its turn was stopped', () => {
    const stopped = chat([
      {
        prompt: 'Tidy the logging.',
        stopped: true,
        steps: [{ kind: 'command', command: 'pnpm vitest run src/webhooks', open: true }],
      },
      { prompt: 'Add the query.', open: true },
    ])
    const brief = deriveBrief(stopped)
    expect(brief.running).toBe(true)
    expect(brief.checks).toMatchObject([
      { kind: 'test', state: 'ended', result: 'did not finish', turn: 1 },
    ])
  })
})

describe('deriveBrief: a running turn', () => {
  const state = chat([
    { prompt: 'Find the double charge.', answer: 'Found it.' },
    {
      prompt: 'Tidy the logging and add a duplicate-deliveries query.',
      open: true,
      steps: [
        plan(
          ['Replace console calls', 'done'],
          ['Add the query', 'done'],
          ['Run the webhook suite', 'running'],
          ['Summarise', 'pending'],
        ),
        {
          kind: 'note',
          text: 'Running the suite to make sure the logging change broke nothing.\n\nThen the query.',
        },
        {
          kind: 'command',
          command: 'pnpm vitest run src/webhooks',
          exitCode: 1,
          output: 'Tests  1 failed | 41 passed',
        },
        { kind: 'command', command: 'pnpm vitest run src/webhooks', open: true },
      ],
    },
  ])
  const brief = deriveBrief(state, { projectPath: PROJECT })

  it('says what it is doing now, with the plan step', () => {
    expect(state.running).toBe(true)
    expect(brief.running).toBe(true)
    expect(brief.now).toMatchObject({
      verb: 'Running',
      object: 'pnpm vitest run src/webhooks',
      command: true,
      step: { index: 3, count: 4 },
      note: 'Running the suite to make sure the logging change broke nothing.',
    })
    expect(brief.turns.at(-1)?.state).toBe('running')
  })

  it('keeps an answer from before and marks the new one pending', () => {
    expect(brief.answer?.turn).toBe(1)
    expect(brief.answerPending).toBe(true)
  })

  it('shows a check still running instead of an earlier failure from the same turn', () => {
    expect(brief.checks).toMatchObject([{ kind: 'test', state: 'running', result: 'running' }])
  })

  it('lists approvals and questions that wait on the user', () => {
    const waiting = chat([
      { prompt: 'Find the double charge.', answer: 'Found it.' },
      {
        prompt: 'Add the query.',
        open: true,
        steps: [
          { kind: 'approval', command: `cd "${PROJECT}" && pnpm db:migrate --env staging` },
          {
            kind: 'question',
            question: 'Where should the query live?',
            options: ['Metabase', 'Grafana panel'],
          },
        ],
      },
    ])
    const asks = deriveBrief(waiting, { projectPath: PROJECT })
    expect(asks.needsYou).toMatchObject([
      {
        kind: 'approval',
        title: 'Run a command',
        command: 'pnpm db:migrate --env staging',
        cwd: '.',
      },
      {
        kind: 'question',
        question: 'Where should the query live?',
        options: ['Metabase', 'Grafana panel'],
        more: 0,
      },
    ])
    expect(asks.now?.verb).toBe('Waiting for you')
    expect(deriveBrief(waiting, { asOfTurn: 1 }).needsYou).toEqual([])
  })

  it('keeps a failing check from a running turn neutral', () => {
    const failing = chat([
      { prompt: 'One', answer: 'ok' },
      {
        prompt: 'Two',
        open: true,
        steps: [{ kind: 'command', command: 'pnpm test', exitCode: 1 }],
      },
    ])
    expect(deriveBrief(failing).checks).toMatchObject([
      { kind: 'test', state: 'pending', result: 'exit 1' },
    ])
  })
})

describe('deriveBrief: a long chat', () => {
  const turns: TurnSpec[] = []
  for (let index = 1; index <= 14; index += 1) {
    turns.push({
      prompt: `Step ${index} of the paging work`,
      steps: [
        { kind: 'edit', path: `apps/web/src/ui/file-${index % 12}.ts`, added: index, removed: 1 },
      ],
      answer: `Answer ${index}`,
    })
  }
  const brief = deriveBrief(chat(turns), { projectPath: PROJECT })

  it('keeps every turn and every file', () => {
    expect(brief.turns).toHaveLength(14)
    expect(brief.changes.files).toHaveLength(12)
    expect(brief.changes.files[0]).toMatchObject({ name: 'file-1.ts', turns: [1, 13] })
    expect(brief.asked?.earlier).toHaveLength(13)
  })
})

describe('brief helpers', () => {
  it('recognises checks by the tool at the head of each step', () => {
    expect(checkKinds('pnpm vitest run src')).toEqual(['test'])
    expect(checkKinds('pnpm vitest bench')).toEqual([])
    expect(checkKinds('npx jest --ci')).toEqual(['test'])
    expect(checkKinds('npm test')).toEqual(['test'])
    expect(checkKinds('npm run test:unit')).toEqual(['test'])
    expect(checkKinds('pnpm --filter web test')).toEqual(['test'])
    expect(checkKinds('python -m pytest -q')).toEqual(['test'])
    expect(checkKinds('go test ./...')).toEqual(['test'])
    expect(checkKinds('cargo clippy')).toEqual(['lint'])
    expect(checkKinds('tsc --noEmit -p apps/web')).toEqual(['typecheck'])
    expect(checkKinds('pnpm exec tsc -b')).toEqual(['build'])
    expect(checkKinds('pnpm lint && pnpm typecheck && pnpm test && pnpm build')).toEqual([
      'lint',
      'typecheck',
      'test',
      'build',
    ])
    expect(checkKinds('cat src/handler.test.ts')).toEqual([])
    expect(checkKinds('rg vitest package.json')).toEqual([])
    expect(checkKinds('git commit -m "build: bump"')).toEqual([])
    expect(checkKinds(`/bin/zsh -lc 'pnpm test'`)).toEqual(['test'])
  })

  it('unwraps shells and a leading absolute cd', () => {
    expect(displayCommand(`/bin/zsh -lc 'pnpm test'`)).toBe('pnpm test')
    expect(displayCommand(`"C:\\Program Files\\Git\\bin\\bash.exe" -lc "ls"`)).toBe('ls')
    expect(displayCommand(`pwsh -NoProfile -Command pnpm lint`)).toBe('pnpm lint')
    expect(displayCommand(`cmd.exe /c pnpm build`)).toBe('pnpm build')
    expect(displayCommand(`cd "E:\\work\\app" && pnpm test`)).toBe('pnpm test')
    expect(displayCommand(`cd packages/web && pnpm test`)).toBe('cd packages/web && pnpm test')
  })

  it('reads test runner summaries', () => {
    expect(testCounts('      Tests  1 failed | 180 passed (181)')).toEqual({
      failed: 1,
      passed: 180,
    })
    expect(testCounts('Tests:       2 failed, 40 passed, 42 total')).toEqual({
      failed: 2,
      passed: 40,
    })
    expect(testCounts('===== 3 failed, 97 passed in 4.21s =====')).toEqual({
      failed: 3,
      passed: 97,
    })
    expect(testCounts('  12 passing (40ms)\n  1 failing')).toEqual({ passed: 12, failed: 1 })
    expect(testCounts('done')).toBeUndefined()
  })

  it('makes paths project-relative on both separators', () => {
    expect(projectRelativePath('E:\\work\\payments-api\\src\\a.ts', PROJECT)).toBe('src/a.ts')
    expect(projectRelativePath('e:/WORK/payments-api/src/a.ts', PROJECT)).toBe('src/a.ts')
    expect(projectRelativePath('/home/me/app/src/a.ts', '/home/me/app/')).toBe('src/a.ts')
    expect(projectRelativePath('/home/me/APP/src/a.ts', '/home/me/app')).toBe('…/APP/src/a.ts')
    expect(projectRelativePath('./src/a.ts', PROJECT)).toBe('src/a.ts')
    expect(projectRelativePath('D:\\elsewhere\\deep\\tree\\src\\a.ts', PROJECT)).toBe(
      '…/tree/src/a.ts',
    )
  })

  it('parses a file change once', () => {
    const item: Item = {
      id: 'f',
      turnId: 't',
      type: 'file_change',
      status: 'completed',
      path: 'a.ts',
      text: '@@ -1 +1 @@\n-a\n+b',
      createdAt: 0,
    }
    expect(fileDeltas(item)).toBe(fileDeltas(item))
    expect(fileDeltas(item)).toEqual([{ path: 'a.ts', added: 1, removed: 1, deleted: false }])
  })

  it('words turns, durations and clocks', () => {
    expect(turnsLabel([2])).toBe('turn 2')
    expect(turnsLabel([2, 3])).toBe('turns 2 · 3')
    expect(turnsLabel([4, 5, 6, 7, 8, 9, 12])).toBe('turns 4–9 · 12')
    expect(briefDuration(41_000)).toBe('41s')
    expect(briefDuration(408_000)).toBe('6m 48s')
    expect(briefDuration(4_320_000)).toBe('1h 12m')
    expect(briefClock(118_000)).toBe('1:58')
    expect(briefClock(3_764_000)).toBe('1:02:44')
  })
})
