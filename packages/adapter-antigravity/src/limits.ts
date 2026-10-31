import { captureCli, type CapturedCli } from '@harness/proc/cli'
import { z } from 'zod'
import { ANTIGRAVITY_ENVIRONMENT, antigravityCommand, spawnAgy, type AgySpawn } from './command.js'
import { antigravitySignIn } from './sign-in.js'

/**
 * Antigravity's plan limits, from agy's own `-p "/usage" --output-format json`.
 *
 * Since agy 1.1.11 print mode answers its read-only slash commands itself:
 * "without starting an agent turn, spending quota, or leaving a conversation
 * behind" (agy's changelog). Before 1.1.11 the same text fell through to the
 * model as a prompt, so the read checks `agy --version` first and never runs
 * it on an older agy. agy fetches the quota with its own sign-in; nothing here
 * reads a credential.
 *
 * Captured with agy 1.4.7 on Windows, stdin closed (fixtures/agy-usage-1.4.7.json):
 * exit 0, `num_turns` 0, empty `conversation_id`, no conversation saved, and
 * `command.data.groups[].buckets[]` with an `id`, a `window` ("5h", "weekly"),
 * a `remaining_fraction` and a `reset_time`. The `response` text repeats each
 * bucket as one tab-separated line with a rounded percentage.
 */

export type ProviderLimit = {
  /** agy's own bucket id, so a later read replaces exactly this row. */
  id?: string | undefined
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  windowMinutes?: number | undefined
}

export type AntigravityLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

/** The first agy whose print mode answers `/usage` itself instead of sending it as a prompt. */
export const AGY_USAGE_MIN_VERSION = '1.1.11'

/** `agy --version` answered in 0.3 s; the margin is for a loaded machine. */
const VERSION_TIMEOUT_MS = 30_000
/**
 * `/usage` starts agy's language server and asks Google for the quota: 4.5 to
 * 11.6 s here. `agy models`, which starts the same server, needed 72 s with
 * the CPU at 100%.
 */
const USAGE_TIMEOUT_MS = 90_000
const OUTPUT_LIMIT_BYTES = 1024 * 1024
const NOT_REPORTED = 'Antigravity did not report its plan limits.'
const NO_VERSION = 'agy did not report its version.'

/** Windows agy names in words; "5h"-style windows are read from their number. */
const NAMED_WINDOWS = {
  daily: { minutes: 1440, label: 'daily' },
  weekly: { minutes: 10_080, label: 'weekly' },
} as const satisfies Record<string, { minutes: number; label: string }>

function namedWindow(window: string | undefined) {
  const key = window?.trim().toLowerCase()
  return key !== undefined && Object.hasOwn(NAMED_WINDOWS, key)
    ? NAMED_WINDOWS[key as keyof typeof NAMED_WINDOWS]
    : undefined
}

const BucketSchema = z.looseObject({
  id: z.string().min(1).max(80).optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  window: z.string().optional().catch(undefined),
  remaining_fraction: z.number().finite().optional().catch(undefined),
  reset_time: z.string().optional().catch(undefined),
  disabled: z.boolean().optional().catch(undefined),
})
const GroupSchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  buckets: z.array(z.unknown()).optional().catch(undefined),
})
const UsageOutputSchema = z.looseObject({
  status: z.string().optional().catch(undefined),
  response: z.string().optional().catch(undefined),
  command: z
    .looseObject({
      data: z
        .looseObject({ groups: z.array(z.unknown()) })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
})

type Bucket = z.infer<typeof BucketSchema>

/** "5h" → 300, "weekly" → 10080; undefined for a window this mapping does not know. */
function windowMinutes(window: string | undefined): number | undefined {
  if (window === undefined) return undefined
  const named = namedWindow(window)
  if (named) return named.minutes
  const match = /^(\d+)\s*([mhd])$/i.exec(window.trim())
  if (!match) return undefined
  const count = Number(match[1])
  const unit = match[2]!.toLowerCase()
  const minutes = unit === 'm' ? count : unit === 'h' ? count * 60 : count * 1440
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : undefined
}

/** "5h" → "5 hours", "weekly" → "weekly"; otherwise agy's own bucket name. */
function windowLabel(bucket: Bucket): string {
  const window = bucket.window?.trim() ?? ''
  const named = namedWindow(window)
  if (named) return named.label
  const hours = /^(\d+)\s*h$/i.exec(window)
  if (hours) return `${hours[1]} hour${hours[1] === '1' ? '' : 's'}`
  const name = bucket.name?.replace(/\s+limit\s+remaining$/i, '').trim()
  return name || window || 'limit'
}

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude and GPT". */
function groupLabel(name: string | undefined): string {
  return (name ?? '').replace(/\s+models?$/i, '').trim()
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * The bucket's share from agy's own text line, for a bucket whose JSON leaves
 * `remaining_fraction` out: agy declares the field `omitempty`, which drops an
 * exactly empty bucket from the JSON while the text line still says "0%".
 */
function textFraction(
  response: string | undefined,
  group: string | undefined,
  bucket: string | undefined,
): number | undefined {
  if (!response || group === undefined || bucket === undefined) return undefined
  for (const line of response.split('\n')) {
    const [lineGroup, lineBucket, value] = line.split('\t')
    if (lineGroup !== group || lineBucket !== bucket) continue
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(value?.trim() ?? '')
    return percent ? Number(percent[1]) / 100 : undefined
  }
  return undefined
}

/** Pure mapping of agy's `/usage` JSON, kept apart from the process for fixture tests. */
export function mapAgyUsage(value: unknown): AntigravityLimitSource {
  const parsed = UsageOutputSchema.safeParse(value)
  const groups = parsed.success ? parsed.data.command?.data?.groups : undefined
  if (!parsed.success || parsed.data.status !== 'SUCCESS' || !groups) {
    throw new Error(NOT_REPORTED)
  }
  // An account without quota buckets has no plan limits to show.
  if (groups.length === 0) return { status: 'unavailable' }
  const limits: ProviderLimit[] = []
  const ids = new Set<string>()
  for (const rawGroup of groups) {
    const group = GroupSchema.safeParse(rawGroup)
    if (!group.success) continue
    const prefix = groupLabel(group.data.name)
    const rows: ProviderLimit[] = []
    for (const rawBucket of group.data.buckets ?? []) {
      const parsedBucket = BucketSchema.safeParse(rawBucket)
      if (!parsedBucket.success) continue
      const bucket = parsedBucket.data
      // agy shows a disabled bucket without a bar; it limits nothing.
      if (bucket.disabled) continue
      const fraction =
        bucket.remaining_fraction ??
        textFraction(parsed.data.response, group.data.name, bucket.name)
      if (fraction === undefined || !Number.isFinite(fraction)) continue
      const remaining = Math.max(0, Math.min(1, fraction))
      const window = windowLabel(bucket)
      const label = (
        prefix ? `${prefix} ${window}` : window.charAt(0).toUpperCase() + window.slice(1)
      ).slice(0, 120)
      const id = bucket.id ?? (slug(`${prefix} ${window}`) || undefined)
      if (id !== undefined && ids.has(id)) continue
      if (id !== undefined) ids.add(id)
      const resetsAt = bucket.reset_time === undefined ? Number.NaN : Date.parse(bucket.reset_time)
      const minutes = windowMinutes(bucket.window)
      rows.push({
        ...(id === undefined ? {} : { id: id.slice(0, 80) }),
        label,
        usedPercent: Math.round((1 - remaining) * 10_000) / 100,
        // An untouched bucket reports now plus its window, a time that moves
        // with every read (captured: three reads, three times), not a reset.
        ...(remaining < 1 && Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        ...(minutes === undefined ? {} : { windowMinutes: minutes }),
      })
    }
    // The shorter window first, as Claude's Session before Weekly.
    rows.sort(
      (a, b) =>
        (a.windowMinutes ?? Number.POSITIVE_INFINITY) -
        (b.windowMinutes ?? Number.POSITIVE_INFINITY),
    )
    limits.push(...rows)
  }
  return { status: 'ready', limits }
}

/** "1.4.7" → [1, 4, 7]; undefined for text without a version. */
function versionParts(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** Whether this agy answers `-p "/usage"` itself; undefined when it named no version. */
export function agyAnswersUsage(versionOutput: string): boolean | undefined {
  const version = versionParts(versionOutput)
  if (!version) return undefined
  const minimum = versionParts(AGY_USAGE_MIN_VERSION)!
  for (let index = 0; index < 3; index += 1) {
    if (version[index]! !== minimum[index]!) return version[index]! > minimum[index]!
  }
  return true
}

/** One agy run with stdin closed: agy waits forever on a piped stdin that stays open. */
function runAgy(spawn: AgySpawn, args: string[], timeoutMs: number): Promise<CapturedCli> {
  const child = spawn(antigravityCommand(), args, {
    env: ANTIGRAVITY_ENVIRONMENT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const captured = captureCli(child, timeoutMs, OUTPUT_LIMIT_BYTES, 'agy')
  child.stdin.on('error', () => undefined)
  child.stdin.end()
  return captured
}

/** The JSON object agy printed: the whole output, else its last line that is one. */
function lastJsonObject(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    // agy 1.4.7 printed only the object, on one line; anything else before it is skipped.
  }
  const lines = stdout.split('\n').map((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Reads agy's plan limits without a prompt. An agy older than 1.1.11 is never
 * asked, since it would send `/usage` to the model; it reports no limits.
 */
export async function antigravityLimitSource(
  spawn: AgySpawn = spawnAgy,
): Promise<AntigravityLimitSource> {
  const version = await runAgy(spawn, ['--version'], VERSION_TIMEOUT_MS)
  const answers = agyAnswersUsage(`${version.stdout}\n${version.stderr}`)
  if (answers === undefined) throw new Error(NO_VERSION)
  if (!answers) return { status: 'unavailable' }

  const result = await runAgy(spawn, ['-p', '/usage', '--output-format', 'json'], USAGE_TIMEOUT_MS)
  if (antigravitySignIn(result) === false) return { status: 'unavailable' }
  // agy's own error text can name the account, so only a stable message leaves.
  return mapAgyUsage(lastJsonObject(result.stdout))
}
