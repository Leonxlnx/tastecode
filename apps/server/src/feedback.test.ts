import { randomUUID } from 'node:crypto'
import type { FeedbackDraft } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { FEEDBACK_LIMITS, FeedbackService, type FeedbackServiceOptions } from './feedback.js'

// Fake values only. A real inbox key must never appear in this repository.
const KEY = 'fb_test_000'
const URL = 'https://feedback.test/api/feedback'

type Reply = () => Response | Promise<Response>
/** Stands in for the store's settings row. */
type LedgerCell = { value?: string }

function created(): Response {
  return new Response(JSON.stringify({ ok: true, id: 'entry-1' }), { status: 201 })
}

function setup(overrides: Partial<FeedbackServiceOptions> = {}, shared?: LedgerCell) {
  let now = 1_800_000_000_000
  const ledger = shared ?? {}
  const replies: Reply[] = []
  const logs: string[] = []
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const reply = replies.shift()
    return reply ? reply() : created()
  })
  const service = new FeedbackService({
    config: { endpoint: { url: URL, key: KEY } },
    ledger: {
      read: () => ledger.value,
      write: (value) => {
        ledger.value = value
      },
    },
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
    appVersion: '0.1.2',
    platform: 'win32',
    osRelease: '10.0.26200',
    arch: 'x64',
    home: 'C:\\Users\\Ada',
    knownPaths: () => ['D:\\Work\\app'],
    providerLabel: (provider) => (provider === 'codex' ? 'Codex 0.48.0' : undefined),
    log: (line) => logs.push(line),
    randomHex: () => '3f9a1c2e',
    ...overrides,
  })
  return {
    service,
    fetch,
    replies,
    logs,
    ledger,
    advance: (ms: number) => {
      now += ms
    },
    sentBody: (call = 0) => JSON.parse(String(fetch.mock.calls[call]?.[1]?.body)) as unknown,
  }
}

function draft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    kind: 'bug',
    message: 'Codex stopped after the first tool call.',
    includeError: true,
    includeDiagnostics: true,
    context: {
      source: 'error_report',
      threadId: 'th1',
      provider: 'codex',
      model: 'gpt-5-codex',
      surface: 'chat',
      error: {
        kind: 'turn',
        message: 'Codex exited unexpectedly: failed to read D:\\Work\\app\\src\\a.ts: denied',
      },
    },
    ...overrides,
  }
}

const submission = (overrides: Partial<FeedbackDraft> = {}) => ({
  ...draft(overrides),
  submissionId: randomUUID(),
})

describe('feedback configuration', () => {
  it('is hidden and never sends when this build has no inbox key', async () => {
    const { service, fetch } = setup({ config: {} })
    expect(service.status()).toEqual({ enabled: false, reason: 'not_configured' })
    expect(await service.submit(submission())).toMatchObject({ ok: false, code: 'not_configured' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports an invalid endpoint without printing it', () => {
    const logs: string[] = []
    const service = new FeedbackService({
      config: { invalid: true },
      ledger: { read: () => undefined, write: () => undefined },
      log: (line) => logs.push(line),
    })
    expect(service.status()).toEqual({ enabled: false, reason: 'not_configured' })
    expect(logs).toEqual(['[feedback] disabled: invalid endpoint config'])
  })
})

describe('feedback payload', () => {
  it('sends exactly what the preview showed, with the key only in the header', async () => {
    const { service, fetch, sentBody } = setup()
    const preview = service.preview(draft())
    expect(JSON.parse(preview.payload)).toEqual({
      kind: 'bug',
      message:
        'Codex stopped after the first tool call.\n\n---\nError shown in TasteCode (redacted):\nCodex exited unexpectedly: failed to read <path>: denied',
      metadata: {
        app: 'TasteCode',
        app_version: '0.1.2',
        platform: 'Windows 10.0.26200 x64',
        source: 'Error report',
        provider: 'Codex 0.48.0',
        model: 'gpt-5-codex',
        surface: 'Chat',
        error_kind: 'Failed turn',
        install: '3f9a1c2e',
      },
    })
    expect(preview.redactions).toBe(1)

    expect(await service.submit(submission())).toEqual({ ok: true })
    expect(sentBody()).toEqual(JSON.parse(preview.payload))
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(URL)
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-trecko-key': KEY,
        'user-agent': 'TasteCode-Feedback',
      },
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends only the app name when the user turns details off', () => {
    const { service } = setup()
    const payload = JSON.parse(
      service.preview(draft({ includeDiagnostics: false, includeError: false })).payload,
    )
    expect(payload).toEqual({
      kind: 'bug',
      message: 'Codex stopped after the first tool call.',
      metadata: { app: 'TasteCode' },
    })
  })

  it('names a custom harness generically and keeps a typed email only when valid', () => {
    const { service } = setup()
    const custom = draft({
      email: '  ada@example.com ',
      context: { source: 'account_menu', provider: 'codex', custom: true },
    })
    const payload = JSON.parse(service.preview(custom).payload)
    expect(payload.email).toBe('ada@example.com')
    expect(payload.metadata.provider).toBe('Custom harness')
    expect(payload.metadata.source).toBe('Account menu')
    expect(JSON.parse(service.preview({ ...custom, email: 'not an email' }).payload).email).toBe(
      undefined,
    )
  })

  it('lets an attached error stand alone but refuses an empty report', async () => {
    const { service, fetch } = setup()
    const errorOnly = JSON.parse(service.preview(draft({ message: '   ' })).payload)
    expect(errorOnly.message.startsWith('Error shown in TasteCode (redacted):\n')).toBe(true)
    expect(
      await service.submit(submission({ message: ' \n ', includeError: false })),
    ).toMatchObject({ ok: false, code: 'empty' })
    expect(service.preview(draft({ message: '', includeError: false }))).toEqual({
      payload: '',
      redactions: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('feedback limits', () => {
  it('waits 30 s after a success and 10 s after a failure, without calling the inbox', async () => {
    const { service, fetch, replies, advance } = setup()
    expect(await service.submit(submission({ message: 'one' }))).toEqual({ ok: true })
    const blocked = await service.submit(submission({ message: 'two' }))
    expect(blocked).toMatchObject({ ok: false, code: 'cooldown', retryAfterMs: 30_000 })
    expect(service.status()).toEqual({ enabled: true, retryAfterMs: 30_000 })
    advance(30_000)
    replies.push(() => {
      throw new TypeError('fetch failed')
    })
    expect(await service.submit(submission({ message: 'two' }))).toMatchObject({ code: 'network' })
    expect(await service.submit(submission({ message: 'two' }))).toMatchObject({
      code: 'cooldown',
      retryAfterMs: 10_000,
    })
    advance(10_000)
    expect(await service.submit(submission({ message: 'two' }))).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('caps successful sends and attempts per rolling day', async () => {
    const sends = setup()
    for (let index = 0; index < FEEDBACK_LIMITS.sentPerDay; index += 1) {
      expect(await sends.service.submit(submission({ message: `report ${index}` }))).toEqual({
        ok: true,
      })
      sends.advance(FEEDBACK_LIMITS.successCooldownMs)
    }
    const full = await sends.service.submit(submission({ message: 'one more' }))
    expect(full).toMatchObject({ ok: false, code: 'daily_limit' })
    expect(sends.fetch).toHaveBeenCalledTimes(FEEDBACK_LIMITS.sentPerDay)
    sends.advance(FEEDBACK_LIMITS.dayMs)
    expect(await sends.service.submit(submission({ message: 'one more' }))).toEqual({ ok: true })

    const attempts = setup()
    for (let index = 0; index < FEEDBACK_LIMITS.attemptsPerDay; index += 1) {
      attempts.replies.push(() => new Response('down', { status: 503 }))
      expect(await attempts.service.submit(submission())).toMatchObject({ code: 'unavailable' })
      attempts.advance(FEEDBACK_LIMITS.failureCooldownMs)
    }
    expect(await attempts.service.submit(submission())).toMatchObject({ code: 'daily_limit' })
    expect(attempts.fetch).toHaveBeenCalledTimes(FEEDBACK_LIMITS.attemptsPerDay)
  })

  it('refuses the same report twice in a day, ignoring case and spacing', async () => {
    const { service, fetch, advance } = setup()
    expect(await service.submit(submission({ message: 'Export  does nothing' }))).toEqual({
      ok: true,
    })
    advance(FEEDBACK_LIMITS.successCooldownMs)
    expect(await service.submit(submission({ message: 'export does NOTHING ' }))).toMatchObject({
      code: 'duplicate',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('answers a repeated submission id once and refuses a second send while one is in flight', async () => {
    const { service, fetch, replies } = setup()
    let release!: (response: Response) => void
    replies.push(() => new Promise<Response>((resolve) => (release = resolve)))
    const first = submission()
    const pending = service.submit(first)
    const again = service.submit(first)
    expect(await service.submit(submission({ message: 'other' }))).toMatchObject({ code: 'busy' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release(created())
    expect(await pending).toEqual({ ok: true })
    expect(await again).toEqual({ ok: true })
    expect(await service.submit(first)).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps limits across a restart because they live in the store', async () => {
    const shared: LedgerCell = {}
    const before = setup({}, shared)
    expect(await before.service.submit(submission())).toEqual({ ok: true })
    const after = setup({}, shared)
    expect(await after.service.submit(submission({ message: 'new' }))).toMatchObject({
      code: 'cooldown',
    })
    expect(after.fetch).not.toHaveBeenCalled()
    expect(shared.value).not.toContain('Codex stopped')
  })

  it('starts fresh from an unreadable ledger', async () => {
    const { service } = setup({}, { value: '{not json' })
    expect(await service.submit(submission())).toEqual({ ok: true })
  })
})

describe('inbox answers', () => {
  it('backs off for the Retry-After the inbox asked for', async () => {
    const { service, fetch, replies, advance } = setup()
    replies.push(
      () =>
        new Response(JSON.stringify({ ok: false, code: 'rate-limited', error: 'Slow down.' }), {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
    )
    expect(await service.submit(submission())).toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 120_000,
      message: 'Too many reports. Try again in 2 min.',
    })
    advance(60_000)
    expect(await service.submit(submission())).toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 60_000,
    })
    expect(service.status()).toEqual({ enabled: true, retryAfterMs: 60_000 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('latches a paused inbox for ten minutes', async () => {
    const { service, fetch, replies, advance } = setup()
    replies.push(() => new Response(JSON.stringify({ code: 'paused' }), { status: 403 }))
    expect(await service.submit(submission())).toMatchObject({ code: 'paused' })
    expect(service.status()).toMatchObject({ enabled: true, reason: 'paused' })
    advance(FEEDBACK_LIMITS.failureCooldownMs)
    expect(await service.submit(submission())).toMatchObject({ code: 'paused' })
    advance(FEEDBACK_LIMITS.pausedMs)
    expect(await service.submit(submission())).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops for the session after the inbox rejects the key', async () => {
    const { service, fetch, replies, advance } = setup()
    replies.push(() => new Response(JSON.stringify({ code: 'invalid-key' }), { status: 401 }))
    expect(await service.submit(submission())).toMatchObject({ code: 'unavailable' })
    expect(service.status()).toEqual({ enabled: false, reason: 'unavailable' })
    advance(FEEDBACK_LIMITS.dayMs)
    expect(await service.submit(submission())).toMatchObject({ code: 'unavailable' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shows the inbox reason for a refused payload as one plain line', async () => {
    const { service, replies } = setup()
    replies.push(
      () =>
        new Response(
          JSON.stringify({ ok: false, code: 'invalid', error: 'Message is <b>too</b>\nlong.' }),
          { status: 422 },
        ),
    )
    expect(await service.submit(submission())).toMatchObject({
      code: 'rejected',
      message: 'The feedback inbox refused this report: Message is b too /b long.',
    })
  })

  it.each([
    ['a server error', () => new Response('<html>oops</html>', { status: 502 }), 'unavailable'],
    ['a redirect', () => new Response(null, { status: 302 }), 'unavailable'],
    [
      'an oversized answer',
      () => new Response('x'.repeat(FEEDBACK_LIMITS.maxResponseBytes * 2), { status: 500 }),
      'unavailable',
    ],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
      'timeout',
    ],
    [
      'no network',
      () => {
        throw new TypeError('fetch failed')
      },
      'network',
    ],
  ] as const)('maps %s without retrying', async (_label, reply, code) => {
    const { service, fetch, replies } = setup()
    replies.push(reply)
    expect(await service.submit(submission())).toMatchObject({ ok: false, code })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('key hygiene', () => {
  it('never puts the key in logs, previews, results or the stored ledger', async () => {
    const console = vi.spyOn(globalThis.console, 'log').mockImplementation(() => undefined)
    try {
      const { service, replies, logs, ledger, advance } = setup()
      const seen: string[] = []
      seen.push(service.preview(draft({ message: `my key is ${KEY}` })).payload)
      seen.push(JSON.stringify(await service.submit(submission())))
      for (const status of [422, 429, 500, 403, 401]) {
        replies.push(() => new Response(JSON.stringify({ error: `bad ${KEY}` }), { status }))
      }
      advance(FEEDBACK_LIMITS.successCooldownMs)
      for (let index = 0; index < 5; index += 1) {
        seen.push(JSON.stringify(await service.submit(submission({ message: `m${index}` }))))
        advance(FEEDBACK_LIMITS.pausedMs)
      }
      seen.push(JSON.stringify(service.status()), ...logs, ledger.value ?? '')
      seen.push(...console.mock.calls.flat().map(String))
      for (const text of seen) {
        expect(text).not.toContain(KEY)
        expect(text).not.toContain('feedback.test')
      }
      expect(logs.every((line) => /^\[feedback\] (sent|failed \w+( \d+)?)$/.test(line))).toBe(true)
    } finally {
      console.mockRestore()
    }
  })
})
