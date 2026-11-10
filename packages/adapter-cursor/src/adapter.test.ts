import { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { argumentPromptLimit } from '@harness/proc'
import { spawnOwned } from '@harness/proc/kill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorAdapter, CURSOR_CAPABILITIES } from './adapter.js'
import { resetCursorModelsForTests } from './listing.js'
import { resetCursorIndexForTests } from './models.js'

vi.mock('@harness/proc/kill', async (original) => ({
  ...(await original<typeof import('@harness/proc/kill')>()),
  spawnOwned: vi.fn(),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

type CapturedRun = { code: number; stdout: string; stderr: string }

function expiredSignIn(): { status: CapturedRun; models: CapturedRun } {
  return JSON.parse(
    readFileSync(
      new URL('./fixtures/cursor-expired-sign-in-2026-10-14.json', import.meta.url),
      'utf8',
    ),
  ) as { status: CapturedRun; models: CapturedRun }
}

/** `cursor-agent models` as 2026.07.23-e383d2b printed it on 2026-10-16. */
function todayListing(): string {
  return readFileSync(new URL('./fixtures/cursor-models-2026-10-16.txt', import.meta.url), 'utf8')
}

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  vi.mocked(spawnOwned).mockReset()
})

class FakeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ]
  override killed = false

  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('exit', null))
    return true
  }
}

/**
 * `cursor-agent --print --output-format stream-json --force --model kimi-k3
 * "Reply with the single word: pong"` on Windows, 2026.07.23-e383d2b,
 * 2026-11-04. The capture merged stdout and stderr and shortened the cwd and
 * session id. The frames came first, then the refusal, then exit code 1.
 */
const REFUSED_FRAMES = [
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"...","session_id":"35b81d1b-...","model":"Kimi K3 High","permissionMode":"default"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with the single word: pong"}]},"session_id":"35b81d1b-..."}',
].join('\n')
const REFUSAL =
  'ActionRequiredError: Kimi K3 is not included in your weekly usage Buy credits or switch to a Grok model to continue.'

/**
 * The same command with `--model gemini-4-argon`, 2026.07.23, 2026-11-04,
 * stdout and stderr merged, in this order, then exit code 1. The capture
 * elided most frame fields, filled in here as in the Kimi capture; the two
 * text lines are verbatim: the cause, then a generic trailer.
 */
const ARGON_FRAMES = [
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"...","session_id":"...","model":"Gemini 4 Argon Medium","permissionMode":"default"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"session_id":"..."}',
].join('\n')
const ARGON_REFUSAL =
  'ActionRequiredError: Gemini 4 Argon is not included in your weekly usage Buy credits or switch to a Grok model to continue.'
const GENERIC_TRAILER = 'Error: command failed unexpectedly.'

/** What a turn's process prints: all of stdout, and stderr in the chunks it arrives in. */
type TurnOutput = { stdout?: string; stderr?: string[] }

/**
 * One turn whose process prints `output` and then exits with `code`, reduced
 * to the errors, end states and log lines the adapter reported.
 */
async function finishTurn(
  output: TurnOutput,
  code: number,
): Promise<{ errors: string[]; statuses: string[]; logs: string[] }> {
  const child = new FakeChild()
  const adapter = new CursorAdapter({ spawn: () => child })
  const events: DomainEvent[] = []
  const logs: string[] = []
  adapter.on('event', (event) => events.push(event))
  adapter.on('log', (line: string) => logs.push(line))
  const thread = await adapter.startThread('C:\\repo')
  await adapter.sendTurn(thread.id, 'Reply with the single word: pong')

  const drained = Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')])
  for (const chunk of output.stderr ?? []) child.stderr.write(chunk)
  child.stderr.end()
  child.stdout.end(output.stdout ?? '')
  await drained
  child.emit('exit', code)
  child.emit('close', code)
  await adapter.dispose()

  return {
    errors: events.flatMap((event) => (event.type === 'thread.error' ? [event.message] : [])),
    statuses: events.flatMap((event) => (event.type === 'turn.completed' ? [event.status] : [])),
    logs,
  }
}

describe('Cursor adapter', () => {
  it('does not reuse a turn identity when a fresh instance resumes', async () => {
    const first = new CursorAdapter({ spawn: () => new FakeChild() })
    const resumed = new CursorAdapter({ spawn: () => new FakeChild() })
    try {
      const thread = await first.startThread('/repo')
      const previous = await first.sendTurn(thread.id, 'One')
      first.dispose()
      await resumed.resumeThread(thread.id, '/repo')
      expect(await resumed.sendTurn(thread.id, 'Two')).not.toBe(previous)
    } finally {
      first.dispose()
      resumed.dispose()
    }
  })

  it('reports the chat id the CLI names, so a restart resumes that chat', async () => {
    const child = new FakeChild()
    const resumeArgs: string[][] = []
    const adapter = new CursorAdapter({ spawn: () => child })
    const reported: string[] = []
    const thread = await adapter.startThread('/repo')
    adapter.onProviderSessionId((id) => reported.push(id))
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })
    await adapter.sendTurn(thread.id, 'Update README')
    child.stdout.end(readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8'))
    await completed
    adapter.dispose()

    expect(reported).toEqual(['session-1'])
    expect(adapter.providerSessionId).toBe('session-1')
    const resumed = new CursorAdapter({
      spawn: (_command, args) => {
        resumeArgs.push(args)
        return new FakeChild()
      },
    })
    try {
      const again = await resumed.resumeThread(reported[0]!, '/repo')
      const late: string[] = []
      resumed.onProviderSessionId((id) => late.push(id))
      await resumed.sendTurn(again.id, 'Go on')
      expect(late).toEqual(['session-1'])
      expect(resumeArgs[0]).toEqual(expect.arrayContaining(['--resume', 'session-1']))
    } finally {
      resumed.dispose()
    }
  })

  it('says how long a prompt its command line can carry', () => {
    const limit = new CursorAdapter().promptLimit
    expect(limit).toBeGreaterThan(0)
    if (process.platform !== 'win32') expect(limit).toBe(argumentPromptLimit())
  })

  it('starts and maps the documented stream-json wire format', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new CursorAdapter({
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo', {
      model: 'cursor-model',
      instructions: 'Answer plainly.',
    })
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })

    await adapter.sendTurn(thread.id, 'Update README')
    const fixture = readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8')
    child.stdout.end(fixture)
    await completed

    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--model',
      'cursor-model',
      '--',
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nUpdate README',
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: "I'll update " }),
        expect.objectContaining({
          type: 'item.started',
          item: expect.objectContaining({ type: 'file_change', path: 'README.md' }),
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )
  })

  it('starts the bundled node.exe on Windows so a multi-line first prompt survives', async () => {
    // cursor-agent.cmd forwards its arguments through cmd.exe, which cannot
    // carry the line breaks every first prompt has. The node.exe the shim
    // itself starts takes them through native argv quoting.
    const localAppData = mkdtempSync(path.join(tmpdir(), 'cursor-launch-'))
    const version = path.join(localAppData, 'cursor-agent', 'versions', '2026.07.23-e383d2b')
    mkdirSync(version, { recursive: true })
    writeFileSync(path.join(version, 'node.exe'), '')
    writeFileSync(path.join(version, 'index.js'), '')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.stubEnv('LOCALAPPDATA', localAppData)
    vi.mocked(spawnOwned).mockImplementation(() => new FakeChild())
    const adapter = new CursorAdapter()
    try {
      const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })
      await adapter.sendTurn(thread.id, 'line one\nline two')

      expect(spawnOwned).toHaveBeenCalledWith(
        path.join(version, 'node.exe'),
        [
          path.join(version, 'index.js'),
          '--print',
          '--output-format',
          'stream-json',
          '--',
          '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nline one\nline two',
        ],
        expect.objectContaining({ cwd: 'C:\\repo' }),
      )
      expect(vi.mocked(spawnOwned).mock.calls[0]?.[2]).not.toHaveProperty(
        'windowsVerbatimArguments',
      )
    } finally {
      await adapter.dispose()
      rmSync(localAppData, { recursive: true, force: true })
    }
  })

  it('keeps the session instructions for the next turn when the CLI cannot start', async () => {
    const prompts: string[] = []
    let attempts = 0
    const adapter = new CursorAdapter({
      spawn: (_command, args) => {
        attempts += 1
        if (attempts === 1) throw new Error('spawn failed')
        prompts.push(args.at(-1)!)
        return new FakeChild()
      },
    })
    const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })

    await expect(adapter.sendTurn(thread.id, 'first')).rejects.toThrow('spawn failed')
    await adapter.sendTurn(thread.id, 'retry')

    expect(prompts).toEqual([
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nretry',
    ])
    adapter.dispose()
  })

  it('sends images through --image and names other files in the prompt', async () => {
    let args: string[] = []
    const adapter = new CursorAdapter({
      spawn: (_command, value) => {
        args = value
        return new FakeChild()
      },
    })
    const folder = path.join(tmpdir(), 'TasteCode', 'attachments')
    const image = path.join(folder, 'Shot.PNG')
    const notes = path.join(folder, 'spec.pdf')
    const thread = await adapter.startThread('C:\\repo')

    await adapter.sendTurn(thread.id, 'What is wrong here?', [image, notes])

    expect(CURSOR_CAPABILITIES.images).toBe(true)
    expect(args.slice(-6)).toEqual([
      '--image',
      image,
      '--add-dir',
      folder,
      '--',
      `What is wrong here?\n\nAttached files:\n- ${notes}`,
    ])
    adapter.dispose()
  })

  it('keeps a prompt that starts with a dash from being read as an option', async () => {
    // cursor-agent 2026.07.23-e383d2b and 2026.10.22-27dcf5f both answer
    // `--print "- one"` with "error: unknown option '- one'"; behind "--" the
    // same prompt is taken as the prompt.
    let args: string[] = []
    const adapter = new CursorAdapter({
      spawn: (_command, value) => {
        args = value
        return new FakeChild()
      },
    })
    const thread = await adapter.resumeThread('cursor-session-1', 'C:\\repo')

    await adapter.sendTurn(thread.id, '- fix the footer\n- fix the header')

    expect(args.slice(-4)).toEqual([
      '--resume',
      'session-1',
      '--',
      '- fix the footer\n- fix the header',
    ])
    adapter.dispose()
  })

  it('resumes, force-maps trusted modes and interrupts honestly', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new CursorAdapter({
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.resumeThread('cursor-session-1', 'C:\\repo', {
      approval: 'full',
    })

    await adapter.sendTurn(thread.id, 'Continue')
    await adapter.interrupt()

    expect(args).toContain('--force')
    expect(args).toContain('--resume')
    expect(args).toContain('session-1')
    expect(child.killed).toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.completed', status: 'interrupted' }),
    )
    expect(adapter.capabilities).toEqual(CURSOR_CAPABILITIES)
  })

  it('lists concrete account models without the automatic route', async () => {
    const adapter = new CursorAdapter({
      run: async (command, args, timeoutMs) => {
        // `models` took 9–14.5 s on a busy machine; five seconds failed it.
        expect([command, args, timeoutMs]).toEqual(['cursor-agent', ['models'], 60_000])
        return {
          code: 0,
          stdout: [
            'Available models',
            '',
            'auto - Automatic',
            'composer-2.5 - Composer 2.5 Fast (current, default)',
            'claude-4.6-sonnet - Claude 4.6 Sonnet',
            '',
            'Tip: use --model <id> to switch.',
          ].join('\n'),
        }
      },
    })

    await expect(adapter.listModels()).resolves.toEqual([
      {
        id: 'claude-4.6-sonnet',
        displayName: 'Claude 4.6 Sonnet',
        isDefault: false,
        reasoningEfforts: [],
        serviceTiers: [],
        lab: 'Anthropic',
        family: 'claude-sonnet',
        generation: '4.6',
        recommended: true,
      },
      {
        id: 'composer-2.5',
        displayName: 'Composer 2.5 Fast',
        isDefault: true,
        reasoningEfforts: [],
        serviceTiers: [],
        lab: 'Cursor',
        family: 'composer',
        generation: '2.5',
        recommended: true,
      },
    ])
  })

  it('gives the model listing a minute to answer', async () => {
    // cursor-agent fetches the account's models before it prints a line; a
    // cold start took 12.6 s. Through the real runner and its time limit.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    const slow = new FakeChild()
    const silent = new FakeChild()
    vi.mocked(spawnOwned).mockReturnValueOnce(slow).mockReturnValueOnce(silent)
    try {
      const listing = new CursorAdapter().listModels()
      await vi.advanceTimersByTimeAsync(12_000)
      slow.stdout.end(todayListing())
      await new Promise((resolve) => setImmediate(resolve))
      slow.emit('close', 0)
      await expect(listing).resolves.toHaveLength(53)

      resetCursorModelsForTests()
      let settled = false
      const hung = new CursorAdapter().listModels()
      hung.then(
        () => (settled = true),
        () => (settled = true),
      )
      await vi.advanceTimersByTimeAsync(59_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(hung).rejects.toThrow('did not answer within 60 seconds')
      expect(silent.killed).toBe(true)
    } finally {
      vi.useRealTimers()
      resetCursorModelsForTests()
    }
  })

  it('asks for a fresh sign-in when the CLI refuses an expired one', async () => {
    const capture = expiredSignIn()
    const adapter = new CursorAdapter({ run: async () => capture.models })

    await expect(adapter.listModels()).rejects.toThrow(
      'Your Cursor sign-in has expired or is missing. Sign in to Cursor again.',
    )
  })

  it('keeps the plain discovery error for any other failure', async () => {
    const adapter = new CursorAdapter({
      run: async () => ({ code: 1, stdout: '', stderr: 'Error: connect ETIMEDOUT\n' }),
    })

    await expect(adapter.listModels()).rejects.toThrow('Cursor model discovery failed')
  })

  it('completes a turn whose result rides the final unterminated chunk', async () => {
    // cursor-agent writes its result line and exits immediately. The exit
    // races the stdout flush; failing on 'exit' (the pre-fix behavior)
    // reported this successful turn as a crash.
    const child = new FakeChild()
    const adapter = new CursorAdapter({
      spawn: () => child,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'go')

    // No trailing newline — the process died mid-write of its last byte.
    child.stdout.end(
      '{"type":"result","subtype":"success","duration_ms":1,"duration_api_ms":1,"is_error":false,"result":"done","session_id":"s1"}',
    )
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('exit', 0)
    child.emit('close', 0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
  })

  it.each<[string, TurnOutput]>([
    // The CLI's other refusals ("Error: Authentication required", in
    // fixtures/cursor-expired-sign-in-2026-10-14.json) went to stderr. A pipe
    // may hand that line over in pieces.
    [
      'stderr',
      { stdout: `${REFUSED_FRAMES}\n`, stderr: [REFUSAL.slice(0, 30), `${REFUSAL.slice(30)}\n`] },
    ],
    ['stdout', { stdout: `${REFUSED_FRAMES}\n${REFUSAL}\n` }],
  ])('fails a turn the CLI refuses with the reason it printed on %s', async (_stream, output) => {
    const result = await finishTurn(output, 1)

    expect(result).toMatchObject({
      errors: [
        'Kimi K3 is not included in your weekly usage Buy credits or switch to a Grok model to continue.',
      ],
      statuses: ['failed'],
    })
  })

  it.each<[string, TurnOutput]>([
    [
      'both on stderr',
      { stdout: `${ARGON_FRAMES}\n`, stderr: [`${ARGON_REFUSAL}\n${GENERIC_TRAILER}\n`] },
    ],
    ['both on stdout', { stdout: `${ARGON_FRAMES}\n${ARGON_REFUSAL}\n${GENERIC_TRAILER}\n` }],
    // Two pipes do not keep the order between them; the trailer may come first.
    [
      'the cause on stdout, the trailer on stderr',
      { stdout: `${ARGON_FRAMES}\n${ARGON_REFUSAL}\n`, stderr: [`${GENERIC_TRAILER}\n`] },
    ],
    [
      'the cause on stderr, the trailer on stdout',
      { stdout: `${ARGON_FRAMES}\n${GENERIC_TRAILER}\n`, stderr: [`${ARGON_REFUSAL}\n`] },
    ],
  ])('names the cause, not the generic error after it, with %s', async (_where, output) => {
    const result = await finishTurn(output, 1)

    expect(result).toMatchObject({
      errors: [
        'Gemini 4 Argon is not included in your weekly usage Buy credits or switch to a Grok model to continue.',
      ],
      statuses: ['failed'],
    })
  })

  it('names the first plain error when no typed one was printed', async () => {
    // Not captured together: the sign-in refusal from
    // fixtures/cursor-expired-sign-in-2026-10-14.json, then the trailer.
    const result = await finishTurn(
      {
        stderr: [
          "Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.\n",
          `${GENERIC_TRAILER}\n`,
        ],
      },
      1,
    )

    expect(result.errors).toEqual([
      "Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.",
    ])
  })

  it.each(['stdout', 'stderr'] as const)(
    'fails a turn in a folder Cursor does not trust with its notice on %s',
    async (stream) => {
      // Without --force the CLI prints this notice and exits 1. Only these
      // lines of it were captured; the ones between the question and the
      // last line are left out.
      const notice = [
        'Cursor Agent can execute code and access files in this directory.',
        '',
        'Do you trust the contents of this directory?',
        '',
        'Pass --trust, --yolo, or -f if you trust this directory',
        '',
      ].join('\n')

      const output: TurnOutput = stream === 'stdout' ? { stdout: notice } : { stderr: [notice] }
      const result = await finishTurn(output, 1)

      expect(result).toMatchObject({
        errors: [
          'Cursor Agent can execute code and access files in this directory. Do you trust the contents of this directory? Pass --trust, --yolo, or -f if you trust this directory',
        ],
        statuses: ['failed'],
      })
    },
  )

  it('keeps the exit code as the message when the CLI exits without a reason', async () => {
    const result = await finishTurn({ stdout: `${REFUSED_FRAMES}\n` }, 1)

    expect(result).toMatchObject({
      errors: ['cursor-agent exited with code 1'],
      statuses: ['failed'],
    })
  })

  it('leaves a successful turn as it was, whatever else the CLI printed', async () => {
    // Made-up stderr: even an error line does not fail a turn that completed.
    const result = await finishTurn(
      {
        stdout: readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8'),
        stderr: ['Error: a warning the turn survived\n'],
      },
      0,
    )

    expect(result).toMatchObject({ errors: [], statuses: ['completed'] })
    expect(result.logs).toContain('Error: a warning the turn survived')
  })

  it('keeps the turn alive past a frame it cannot read', async () => {
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    const logs: string[] = []
    adapter.on('event', (event) => events.push(event))
    adapter.on('log', (line: string) => logs.push(line))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'go')

    // `message: null` fails the schema; the frame after it is still read.
    const drained = new Promise<void>((resolve) => child.stdout.once('end', resolve))
    child.stdout.end(
      [
        '{"type":"assistant","message":null}',
        '{"type":"result","subtype":"success","duration_ms":1,"is_error":false,"result":"done","session_id":"s1"}',
      ].join('\n'),
    )
    await drained

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(logs.some((line) => line.startsWith('Cursor event handling failed'))).toBe(true)
    expect(child.killed).toBe(false)
    adapter.dispose()
  })

  it('logs a throwing event listener instead of failing the turn', async () => {
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    const logs: string[] = []
    let thrown = false
    adapter.on('event', (event) => {
      events.push(event)
      if (event.type === 'item.started' && !thrown) {
        thrown = true
        throw new Error('listener failed')
      }
    })
    adapter.on('log', (line: string) => logs.push(line))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'go')

    const drained = new Promise<void>((resolve) => child.stdout.once('end', resolve))
    child.stdout.end(
      [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":" there"}]}}',
        '{"type":"result","subtype":"success","duration_ms":1,"is_error":false,"result":"done","session_id":"s1"}',
      ].join('\n'),
    )
    await drained

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(logs.some((line) => line.includes('listener failed'))).toBe(true)
    expect(child.killed).toBe(false)
    adapter.dispose()
  })

  it('keeps text before, between and after tool calls as separate messages', async () => {
    // The shape of a 2026-11-04 Grok 4.7 turn (cursor-agent 2026.07.23) that
    // showed as one message with its segments glued together. Built from the
    // CLI's stream-json writer: each `assistant` line is the whole text since
    // the previous flush, and `result` repeats all of it without separators.
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Count the words')
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })
    const intro = "I'll write a script that counts the words so you can see the top 10 words."
    const middle = "The workspace is empty, so I'll add the script and then run it."
    const answer = '`wordfreq.mjs` prints the 10 most frequent words with their counts.'
    const say = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        session_id: 's1',
        model_call_id: 'm1',
        timestamp_ms: 1,
      })
    const tool = (subtype: string, callId: string, call: object) =>
      JSON.stringify({ type: 'tool_call', subtype, call_id: callId, tool_call: call })
    const list = { lsToolCall: { args: { path: 'C:\\repo' } } }
    const write = { writeToolCall: { args: { path: 'wordfreq.mjs', fileText: 'x' } } }
    const run = { shellToolCall: { args: { command: 'node wordfreq.mjs' } } }

    child.stdout.end(
      [
        say(intro),
        tool('started', 'call-1', list),
        tool('completed', 'call-1', list),
        say(middle),
        tool('started', 'call-2', write),
        tool('completed', 'call-2', write),
        tool('started', 'call-3', run),
        tool('completed', 'call-3', run),
        say(answer),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          duration_ms: 4200,
          is_error: false,
          result: intro + middle + answer,
          session_id: 's1',
        }),
      ].join('\n'),
    )
    await completed

    const trace = events.flatMap((event) => {
      if (event.type === 'item.delta') return [`delta ${event.itemId.slice(turnId.length + 1)}`]
      if (event.type !== 'item.started' && event.type !== 'item.completed') return []
      return [`${event.type.slice(5)} ${event.item.id.slice(turnId.length + 1)}`]
    })
    expect(trace).toEqual([
      'started message',
      'delta message',
      'completed message',
      'started call-1',
      'completed call-1',
      'started message-2',
      'delta message-2',
      'completed message-2',
      'started call-2',
      'completed call-2',
      'started call-3',
      'completed call-3',
      'started message-3',
      'delta message-3',
      'completed message-3',
    ])
    const messages = events.flatMap((event) =>
      event.type === 'item.completed' && event.item.type === 'message' ? [event.item] : [],
    )
    expect(messages).toEqual([
      expect.objectContaining({ id: `${turnId}-message`, status: 'completed', text: intro }),
      expect.objectContaining({ id: `${turnId}-message-2`, status: 'completed', text: middle }),
      expect.objectContaining({
        id: `${turnId}-message-3`,
        status: 'completed',
        text: answer,
        durationMs: 4200,
      }),
    ])
    expect(messages[0]).not.toHaveProperty('durationMs')
    expect(events.at(-1)).toEqual({ type: 'turn.completed', turnId, status: 'completed' })
    adapter.dispose()
  })

  it('maps a turn with one text segment to the same single message as before', async () => {
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Say hi')
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })

    child.stdout.end(
      [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there."}]},"session_id":"s1"}',
        '{"type":"result","subtype":"success","duration_ms":25,"is_error":false,"result":"Hi there.","session_id":"s1"}',
      ].join('\n'),
    )
    await completed

    const id = `${turnId}-message`
    const message = {
      id,
      turnId,
      type: 'message',
      role: 'assistant',
      createdAt: expect.any(Number),
    }
    expect(events.filter((event) => event.type !== 'turn.started')).toEqual([
      { type: 'item.started', item: { ...message, status: 'started', text: '' } },
      { type: 'item.delta', turnId, itemId: id, textDelta: 'Hi there.' },
      {
        type: 'item.completed',
        item: { ...message, status: 'completed', text: 'Hi there.', durationMs: 25 },
      },
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    adapter.dispose()
  })

  it('keeps back-to-back segments apart and fails the open tool when interrupted', async () => {
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'go')
    const say = (text: string) =>
      `{"type":"assistant","message":{"content":[{"type":"text","text":"${text}"}]}}\n`
    const run = (subtype: string, callId: string) =>
      `{"type":"tool_call","subtype":"${subtype}","call_id":"${callId}","tool_call":{"shellToolCall":{"args":{"command":"node a.mjs"}}}}\n`

    // The CLI also flushes its text before a retry or an interaction query,
    // so two whole segments can follow each other without a tool between.
    child.stdout.write(
      say('Checking first.') +
        run('started', 'call-1') +
        run('completed', 'call-1') +
        say('Now') +
        say('Then this.') +
        run('started', 'call-2'),
    )
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.interrupt()

    const completedItems = events.flatMap((event) =>
      event.type === 'item.completed'
        ? [[event.item.id.slice(turnId.length + 1), event.item.status, event.item.text]]
        : [],
    )
    expect(completedItems).toEqual([
      ['message', 'completed', 'Checking first.'],
      ['call-1', 'completed', undefined],
      ['message-2', 'completed', 'Now'],
      ['message-3', 'completed', 'Then this.'],
      ['call-2', 'failed', undefined],
    ])
    expect(events.at(-1)).toEqual({ type: 'turn.completed', turnId, status: 'interrupted' })
  })

  it('fails an open text segment after a tool call when interrupted', async () => {
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'go')

    child.stdout.write(
      [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."}]}}',
        '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"readToolCall":{"args":{"path":"a.md"}}}}',
        '{"type":"tool_call","subtype":"completed","call_id":"call-1","tool_call":{"readToolCall":{"args":{"path":"a.md"}}}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Half an answer"}]}}',
        '',
      ].join('\n'),
    )
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.interrupt()

    const messages = events.flatMap((event) =>
      event.type === 'item.completed' && event.item.type === 'message' ? [event.item] : [],
    )
    expect(messages).toEqual([
      expect.objectContaining({ id: `${turnId}-message`, status: 'completed', text: 'Looking.' }),
      expect.objectContaining({
        id: `${turnId}-message-2`,
        status: 'failed',
        text: 'Half an answer',
      }),
    ])
    expect(events.at(-1)).toEqual({ type: 'turn.completed', turnId, status: 'interrupted' })
  })

  it('lets the next turn start while the finished process is still exiting', async () => {
    const children: FakeChild[] = []
    const adapter = new CursorAdapter({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'first')

    // The result arrives, but the process lingers: no exit/close yet.
    children[0]!.stdout.write(
      '{"type":"result","subtype":"success","duration_ms":1,"duration_api_ms":1,"is_error":false,"result":"done","session_id":"s1"}\n',
    )
    await new Promise((resolve) => setImmediate(resolve))

    // Pre-fix this threw 'a turn is already running' and the queued prompt
    // stalled forever. Now the lingering child is reaped and turn 2 starts.
    await adapter.sendTurn(thread.id, 'second')
    expect(children).toHaveLength(2)
    expect(children[0]!.killed).toBe(true)

    // The old child's close must not fail the new live turn.
    children[0]!.emit('close', 0)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(2)
  })

  it('rejects capabilities the CLI cannot provide', async () => {
    const adapter = new CursorAdapter()
    await expect(adapter.startThread('C:\\repo', { approval: 'auto-review' })).rejects.toThrow(
      'automatic approval review',
    )
  })

  it('applies a per-turn effort and tier using the concrete variant id', async () => {
    const capture = readFileSync(
      new URL('./fixtures/cursor-models-2026-08-07.txt', import.meta.url),
      'utf8',
    )
    resetCursorIndexForTests()
    const child = new FakeChild()
    let args: string[] = []
    let listings = 0
    const adapter = new CursorAdapter({
      run: async () => {
        listings += 1
        return { code: 0, stdout: capture, stderr: '' }
      },
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const thread = await adapter.startThread('C:\\repo', {
      model: 'gpt-5.3-codex',
      effort: 'low',
      serviceTier: 'standard',
    })
    await adapter.sendTurn(thread.id, 'go', [], {
      model: 'gpt-5.3-codex',
      effort: 'xhigh',
      serviceTier: 'fast',
    })

    // A cold index costs exactly one listing run at session start.
    expect(listings).toBe(1)
    expect(args).toContain('gpt-5.3-codex-xhigh-fast')
    adapter.dispose()
  })

  it('passes a defaults-only selection through without a listing run', async () => {
    resetCursorIndexForTests()
    const child = new FakeChild()
    let args: string[] = []
    let listings = 0
    const adapter = new CursorAdapter({
      run: async () => {
        listings += 1
        return { code: 0, stdout: '', stderr: '' }
      },
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const thread = await adapter.startThread('C:\\repo', { model: 'gpt-5.3-codex' })
    await adapter.sendTurn(thread.id, 'go')

    expect(listings).toBe(0)
    expect(args).toContain('gpt-5.3-codex')
    adapter.dispose()
  })
})
