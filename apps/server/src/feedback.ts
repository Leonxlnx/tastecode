import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import type {
  FeedbackDraft,
  FeedbackFailureCode,
  FeedbackPreview,
  FeedbackStatus,
  FeedbackSubmitResult,
  ProviderId,
} from '@harness/contracts'
import { z } from 'zod'
import type { FeedbackConfig, FeedbackEndpoint } from './feedback-config.js'
import { redactAttachedText, redactLabel, redactUserText } from './feedback-redact.js'

/**
 * User feedback, sent to the TasteCode team's Trecko inbox.
 *
 * Only the dialog's Send button reaches `submit`; nothing here runs on a
 * timer, at startup or after an error. The key is extractable from any
 * packaged build, so the inbox carries the real abuse protection. These
 * limits stop TasteCode itself from spamming it: a double click, a loop or a
 * retry storm. They are kept in the store so a restart does not reset them.
 */

export const FEEDBACK_LIMITS = {
  successCooldownMs: 30_000,
  failureCooldownMs: 10_000,
  sentPerDay: 10,
  attemptsPerDay: 20,
  dayMs: 24 * 60 * 60 * 1000,
  timeoutMs: 10_000,
  maxBodyBytes: 16 * 1024,
  maxResponseBytes: 16 * 1024,
  maxBlockMs: 60 * 60 * 1000,
  defaultBlockMs: 60_000,
  pausedMs: 10 * 60 * 1000,
  submissionMemoryMs: 10 * 60 * 1000,
} as const

const USER_MESSAGE_MAX = 4000
const METADATA_VALUE_MAX = 120
const METADATA_JSON_MAX = 1500
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SOURCE_LABELS = {
  account_menu: 'Account menu',
  command_palette: 'Command palette',
  slash_command: '/feedback',
  error_report: 'Error report',
  native_menu: 'Help menu',
} as const satisfies Record<FeedbackDraft['context']['source'], string>

const SURFACE_LABELS = {
  chat: 'Chat',
  design: 'Design',
  pull_requests: 'Pull requests',
  settings: 'Settings',
} as const

const ERROR_LABELS = {
  turn: 'Failed turn',
  action: 'Action error',
  provider: 'Provider setup',
  models: 'Model list',
} as const

const COPY = {
  not_configured: "Feedback isn't available in this build.",
  empty: 'Write a few words first.',
  busy: 'Already sending. One moment.',
  duplicate: 'You already sent this exact report today.',
  daily_limit: 'You sent a lot of feedback today. Try again tomorrow.',
  too_long: 'This report is too long. Shorten it and try again.',
  unavailable: "Couldn't send right now. Your text is still here.",
  invalid_key: "Feedback isn't available in this build right now.",
  paused: 'Feedback is paused right now. Try again later.',
  network: 'You seem to be offline. Your text is still here.',
  timeout: "The feedback inbox didn't answer in time. Your text is still here.",
} as const

const LedgerSchema = z.object({
  installId: z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .optional(),
  cooldownUntil: z.number().optional(),
  blockedUntil: z.number().optional(),
  pausedUntil: z.number().optional(),
  sent: z.array(z.number()).default([]),
  attempts: z.array(z.number()).default([]),
  hashes: z.array(z.object({ h: z.string(), at: z.number() })).default([]),
})
type Ledger = z.infer<typeof LedgerSchema>

const TreckoAnswerSchema = z.object({ error: z.string().optional(), code: z.string().optional() })

export type FeedbackLedgerStore = {
  read(): string | undefined
  write(value: string): void
}

export type FeedbackServiceOptions = {
  config: FeedbackConfig | undefined
  ledger: FeedbackLedgerStore
  fetch?: typeof fetch
  now?: () => number
  appVersion?: string | undefined
  platform?: NodeJS.Platform
  osRelease?: string
  arch?: string
  home?: string
  /** Workspace paths to strip from attached errors: every project, plus the chat's checkout. */
  knownPaths?: (threadId: string | undefined) => readonly string[]
  /** "Codex 0.48.0" from the last provider scan, when one is known. */
  providerLabel?: (provider: ProviderId) => string | undefined
  log?: (line: string) => void
  randomHex?: (bytes: number) => string
}

type Body = {
  kind: FeedbackDraft['kind']
  message: string
  email?: string
  metadata: Record<string, string>
}

type Built = { ok: true; body: Body; redactions: number } | { ok: false }

type Failure = Extract<FeedbackSubmitResult, { ok: false }>

function failure(code: FeedbackFailureCode, message: string, retryAfterMs?: number): Failure {
  return {
    ok: false,
    code,
    message: message.slice(0, 300),
    ...(retryAfterMs !== undefined ? { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) } : {}),
  }
}

function waitCopy(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 90) return `${seconds} s`
  return `${Math.ceil(seconds / 60)} min`
}

function platformLabel(platform: NodeJS.Platform, release: string, arch: string): string {
  if (platform === 'win32') return `Windows ${release} ${arch}`
  if (platform === 'darwin') return `macOS (Darwin ${release}) ${arch}`
  if (platform === 'linux') return `Linux ${release} ${arch}`
  return `${platform} ${release} ${arch}`
}

/**
 * "Codex 0.48.0" from a CLI's own version line, which may repeat the product
 * name ("codex-cli 0.48.0", "2.1.3 (Claude Code)").
 */
export function providerVersionLabel(displayName: string, version: string | undefined): string {
  const semver = version?.match(/\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?/)?.[0]
  return semver ? `${displayName} ${semver}` : displayName
}

function normalizedHash(body: Body): string {
  const normalized = `${body.kind}\n${body.message.trim().toLowerCase().replace(/\s+/g, ' ')}`
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export class FeedbackService {
  readonly #endpoint: FeedbackEndpoint | undefined
  readonly #invalid: boolean
  readonly #options: FeedbackServiceOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #log: (line: string) => void
  #unavailable = false
  #inflight: { id: string; result: Promise<FeedbackSubmitResult> } | undefined
  readonly #recent = new Map<string, { result: FeedbackSubmitResult; at: number }>()

  constructor(options: FeedbackServiceOptions) {
    this.#endpoint = options.config?.endpoint
    this.#invalid = options.config?.invalid === true
    this.#options = options
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? ((line) => console.log(line))
    if (this.#invalid) this.#log('[feedback] disabled: invalid endpoint config')
  }

  status(): FeedbackStatus {
    if (!this.#endpoint) return { enabled: false, reason: 'not_configured' }
    if (this.#unavailable) return { enabled: false, reason: 'unavailable' }
    const now = this.#now()
    const ledger = this.#readLedger(now)
    const wait = this.#wait(ledger, now)
    if ((ledger.pausedUntil ?? 0) > now) {
      return { enabled: true, reason: 'paused', retryAfterMs: ledger.pausedUntil! - now }
    }
    return wait > 0 ? { enabled: true, retryAfterMs: wait } : { enabled: true }
  }

  preview(draft: FeedbackDraft): FeedbackPreview {
    const built = this.#build(draft)
    if (!built.ok) return { payload: '', redactions: 0 }
    return { payload: JSON.stringify(built.body, null, 2), redactions: built.redactions }
  }

  submit(draft: FeedbackDraft & { submissionId: string }): Promise<FeedbackSubmitResult> {
    if (!this.#endpoint) return Promise.resolve(failure('not_configured', COPY.not_configured))
    if (this.#unavailable) return Promise.resolve(failure('unavailable', COPY.invalid_key))
    const now = this.#now()
    for (const [id, entry] of this.#recent) {
      if (now - entry.at > FEEDBACK_LIMITS.submissionMemoryMs) this.#recent.delete(id)
    }
    const remembered = this.#recent.get(draft.submissionId)
    if (remembered) return Promise.resolve(remembered.result)
    if (this.#inflight) {
      return this.#inflight.id === draft.submissionId
        ? this.#inflight.result
        : Promise.resolve(failure('busy', COPY.busy))
    }
    const result = this.#submit(draft, this.#endpoint, now)
    const inflight = { id: draft.submissionId, result }
    this.#inflight = inflight
    return result.finally(() => {
      if (this.#inflight === inflight) this.#inflight = undefined
    })
  }

  async #submit(
    draft: FeedbackDraft & { submissionId: string },
    endpoint: FeedbackEndpoint,
    now: number,
  ): Promise<FeedbackSubmitResult> {
    const built = this.#build(draft)
    if (!built.ok) return failure('empty', COPY.empty)
    const serialized = JSON.stringify(built.body)
    if (Buffer.byteLength(serialized) > FEEDBACK_LIMITS.maxBodyBytes) {
      return failure('rejected', COPY.too_long)
    }

    const ledger = this.#readLedger(now)
    if ((ledger.pausedUntil ?? 0) > now) {
      return failure('paused', COPY.paused, ledger.pausedUntil! - now)
    }
    if ((ledger.blockedUntil ?? 0) > now) {
      const wait = ledger.blockedUntil! - now
      return failure('rate_limited', `Too many reports. Try again in ${waitCopy(wait)}.`, wait)
    }
    if ((ledger.cooldownUntil ?? 0) > now) {
      const wait = ledger.cooldownUntil! - now
      return failure('cooldown', `Wait ${waitCopy(wait)} before sending again.`, wait)
    }
    const dailyFull =
      ledger.sent.length >= FEEDBACK_LIMITS.sentPerDay
        ? ledger.sent
        : ledger.attempts.length >= FEEDBACK_LIMITS.attemptsPerDay
          ? ledger.attempts
          : undefined
    if (dailyFull) {
      const oldest = Math.min(...dailyFull)
      return failure('daily_limit', COPY.daily_limit, oldest + FEEDBACK_LIMITS.dayMs - now)
    }
    const hash = normalizedHash(built.body)
    if (ledger.hashes.some((entry) => entry.h === hash)) {
      return failure('duplicate', COPY.duplicate)
    }

    // Counted before the request leaves: a crash mid-send still uses an attempt.
    ledger.attempts.push(now)
    ledger.cooldownUntil = now + FEEDBACK_LIMITS.failureCooldownMs
    this.#writeLedger(ledger)

    const result = await this.#send(endpoint, serialized, now, ledger)
    if (result.ok) {
      ledger.sent.push(now)
      ledger.hashes.push({ h: hash, at: now })
      ledger.cooldownUntil = now + FEEDBACK_LIMITS.successCooldownMs
    }
    this.#writeLedger(ledger)
    this.#recent.set(draft.submissionId, { result, at: now })
    return result
  }

  async #send(
    endpoint: FeedbackEndpoint,
    body: string,
    now: number,
    ledger: Ledger,
  ): Promise<FeedbackSubmitResult> {
    let response: Response
    try {
      response = await this.#fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-trecko-key': endpoint.key,
          'user-agent': 'TasteCode-Feedback',
        },
        body,
        // A redirect would carry the key header to wherever it points.
        redirect: 'manual',
        signal: AbortSignal.timeout(FEEDBACK_LIMITS.timeoutMs),
      })
    } catch (error) {
      const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : ''
      const timedOut = name === 'TimeoutError' || name === 'AbortError'
      this.#log(`[feedback] failed ${timedOut ? 'timeout' : 'network'}`)
      return timedOut ? failure('timeout', COPY.timeout) : failure('network', COPY.network)
    }

    const status = response.status
    const answer = await readAnswer(response)
    if (status >= 200 && status < 300) {
      this.#log('[feedback] sent')
      return { ok: true }
    }
    let result: Failure
    if (status === 429) {
      const seconds = Number(response.headers.get('retry-after'))
      const wait = Math.min(
        FEEDBACK_LIMITS.maxBlockMs,
        Math.max(
          1000,
          Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : FEEDBACK_LIMITS.defaultBlockMs,
        ),
      )
      ledger.blockedUntil = now + wait
      result = failure('rate_limited', `Too many reports. Try again in ${waitCopy(wait)}.`, wait)
    } else if (status === 403) {
      ledger.pausedUntil = now + FEEDBACK_LIMITS.pausedMs
      result = failure('paused', COPY.paused, FEEDBACK_LIMITS.pausedMs)
    } else if (status === 401) {
      // The key was rotated or never existed: nothing this build sends can work.
      this.#unavailable = true
      result = failure('unavailable', COPY.invalid_key)
    } else if (status === 400 || status === 413 || status === 422) {
      const reason = answer?.error
        ? redactUserText(plainSentence(answer.error), { home: this.#home(), max: 200 }).text
        : ''
      result = failure(
        'rejected',
        reason ? `The feedback inbox refused this report: ${reason}` : COPY.too_long,
      )
    } else {
      result = failure('unavailable', COPY.unavailable)
    }
    this.#log(`[feedback] failed ${result.code} ${status}`)
    return result
  }

  #build(draft: FeedbackDraft): Built {
    const home = this.#home()
    let redactions = 0
    const user = redactUserText(draft.message.slice(0, USER_MESSAGE_MAX), {
      home,
      max: USER_MESSAGE_MAX,
    })
    redactions += user.redactions
    let message = user.text
    const error = draft.includeError ? draft.context.error : undefined
    if (error) {
      const attached = redactAttachedText(error.message, {
        home,
        workspaces: this.#options.knownPaths?.(draft.context.threadId) ?? [],
      })
      redactions += attached.redactions
      if (attached.text) {
        const block = `Error shown in TasteCode (redacted):\n${attached.text}`
        message = message ? `${message}\n\n---\n${block}` : block
      }
    }
    if (!message.trim()) return { ok: false }

    const metadata: Record<string, string> = {}
    metadata['app'] = 'TasteCode'
    if (draft.includeDiagnostics) {
      const label = (value: string | undefined) => {
        if (!value) return undefined
        const redacted = redactLabel(value, { home, max: METADATA_VALUE_MAX })
        redactions += redacted.redactions
        return redacted.text || undefined
      }
      const context = draft.context
      const provider = context.custom
        ? 'Custom harness'
        : context.provider
          ? (this.#options.providerLabel?.(context.provider) ?? context.provider)
          : undefined
      const entries: Array<[string, string | undefined]> = [
        ['app_version', label(this.#options.appVersion || 'dev')],
        [
          'platform',
          platformLabel(
            this.#options.platform ?? process.platform,
            this.#options.osRelease ?? os.release(),
            this.#options.arch ?? process.arch,
          ),
        ],
        ['source', SOURCE_LABELS[context.source]],
        ['provider', label(provider)],
        ['model', label(context.model)],
        ['surface', context.surface ? SURFACE_LABELS[context.surface] : undefined],
        ['error_kind', error ? ERROR_LABELS[error.kind] : undefined],
        ['install', this.#installId()],
      ]
      for (const [key, value] of entries) {
        if (!value) continue
        const next = { ...metadata, [key]: value.slice(0, METADATA_VALUE_MAX) }
        if (JSON.stringify(next).length > METADATA_JSON_MAX) continue
        metadata[key] = value.slice(0, METADATA_VALUE_MAX)
      }
    }

    const email = draft.email?.trim()
    const body: Body = {
      kind: draft.kind,
      message,
      ...(email && email.length <= 254 && EMAIL.test(email) ? { email } : {}),
      metadata,
    }
    return { ok: true, body, redactions }
  }

  #home(): string {
    return this.#options.home ?? os.homedir()
  }

  #installId(): string {
    const ledger = this.#readLedger(this.#now())
    if (ledger.installId) return ledger.installId
    const random = this.#options.randomHex ?? ((bytes) => randomBytes(bytes).toString('hex'))
    ledger.installId = random(4)
    this.#writeLedger(ledger)
    return ledger.installId
  }

  #wait(ledger: Ledger, now: number): number {
    return Math.max(0, (ledger.cooldownUntil ?? 0) - now, (ledger.blockedUntil ?? 0) - now)
  }

  #readLedger(now: number): Ledger {
    let ledger: Ledger
    try {
      const raw = this.#options.ledger.read()
      ledger = LedgerSchema.parse(raw ? JSON.parse(raw) : {})
    } catch {
      ledger = LedgerSchema.parse({})
    }
    const since = now - FEEDBACK_LIMITS.dayMs
    ledger.sent = ledger.sent.filter((at) => at > since && at <= now)
    ledger.attempts = ledger.attempts.filter((at) => at > since && at <= now)
    ledger.hashes = ledger.hashes.filter((entry) => entry.at > since && entry.at <= now)
    for (const field of ['cooldownUntil', 'blockedUntil', 'pausedUntil'] as const) {
      // A clock set back must not lock feedback for longer than the limit itself.
      const until = ledger[field]
      if (until !== undefined && (until <= now || until - now > FEEDBACK_LIMITS.maxBlockMs)) {
        delete ledger[field]
      }
    }
    return ledger
  }

  #writeLedger(ledger: Ledger): void {
    try {
      this.#options.ledger.write(JSON.stringify(ledger))
    } catch {
      this.#log('[feedback] could not save the send ledger')
    }
  }
}

async function readAnswer(
  response: Response,
): Promise<z.infer<typeof TreckoAnswerSchema> | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > FEEDBACK_LIMITS.maxResponseBytes) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  }
  try {
    const parsed = TreckoAnswerSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** The inbox's own sentence, shown as plain text: one line, no markup, short. */
function plainSentence(value: string): string {
  return value
    .replace(/[\p{Cc}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
