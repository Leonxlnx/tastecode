import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { CURSOR_SIGN_IN_REQUIRED } from './auth.js'

/**
 * Cursor's plan usage, read the way cursor-agent's own `/usage` reads it.
 *
 * `/usage` exists only as a screen of the interactive TUI: it is registered
 * in the Ink app (`5305.index.js` ~847968, `./src/usage/usage-command.ts`
 * ~939569) and print mode sends the same text to the model as a prompt. So
 * there is no CLI route like agy's. Instead this makes the one request the
 * screen makes (`./src/usage/usage-data.ts` ~943485 in 2026.07.23-e383d2b):
 * `aiserver.v1.DashboardService/GetCurrentPeriodUsage` on api2.cursor.sh,
 * Connect protocol, binary protobuf, with an empty request and the access
 * token the CLI stored at sign-in.
 *
 * The token is read from the CLI's own store at the moment of the read and
 * goes only into that request's Authorization header: it is never kept,
 * logged, refreshed or written. On Windows and Linux cursor-agent keeps it in
 * a JSON file (`index.js` ~3867258, `../cli-credentials`, domain "cursor"):
 * `%APPDATA%\Cursor\auth.json`, `$XDG_CONFIG_HOME/cursor/auth.json`. On macOS
 * it is in the login keychain, which TasteCode does not open, so macOS
 * reports no Cursor limits.
 */

export type ProviderLimit = {
  id?: string | undefined
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  windowMinutes?: number | undefined
}

export type CursorLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

export type CursorLimitOptions = {
  env?: NodeJS.ProcessEnv | undefined
  platform?: NodeJS.Platform | undefined
  home?: string | undefined
  readText?: ((file: string) => Promise<string>) | undefined
  fetch?: typeof fetch | undefined
  timeoutMs?: number | undefined
}

/** Fixed, so no setting or environment variable can send the token anywhere else. */
export const CURSOR_USAGE_URL =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
/** The CLI gives its dashboard requests the same 15 s. */
const TIMEOUT_MS = 15_000
const RESPONSE_LIMIT_BYTES = 256 * 1024

/** Where cursor-agent keeps its sign-in on this platform; undefined where it is not a file. */
export function cursorAuthFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | undefined {
  if (platform === 'darwin') return undefined
  if (platform === 'win32') {
    const roaming = env['APPDATA'] || path.win32.join(home, 'AppData', 'Roaming')
    return path.win32.join(roaming, 'Cursor', 'auth.json')
  }
  const config = env['XDG_CONFIG_HOME'] || path.posix.join(home, '.config')
  return path.posix.join(config, 'cursor', 'auth.json')
}

export async function cursorLimitSource(
  options: CursorLimitOptions = {},
): Promise<CursorLimitSource> {
  const file = cursorAuthFile(options.env, options.platform, options.home)
  if (file === undefined) return { status: 'unavailable' }
  const token = await storedAccessToken(file, options.readText)
  // Signed out (or signed in with an API key from the environment only).
  if (token === undefined) return { status: 'unavailable' }

  const response = await (options.fetch ?? fetch)(CURSOR_USAGE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
    },
    body: new Uint8Array(0),
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  })
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > RESPONSE_LIMIT_BYTES) throw new Error('Cursor sent an oversized answer.')
  if (!response.ok) throw new Error(failureMessage(response.status, body))
  return cursorLimitsFromUsage(decodeCurrentPeriodUsage(body))
}

async function storedAccessToken(
  file: string,
  readText: ((file: string) => Promise<string>) | undefined,
): Promise<string | undefined> {
  let text: string
  try {
    text = await (readText ?? ((name: string) => readFile(name, 'utf8')))(file)
  } catch {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(text)
    const token =
      typeof value === 'object' && value !== null && 'accessToken' in value
        ? value.accessToken
        : undefined
    return typeof token === 'string' && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/** A Connect error names its code in a small JSON body; only the code is used. */
function failureMessage(status: number, body: Uint8Array): string {
  let code: unknown
  try {
    code = (JSON.parse(new TextDecoder().decode(body)) as { code?: unknown }).code
  } catch {
    code = undefined
  }
  if (status === 401 || code === 'unauthenticated') return CURSOR_SIGN_IN_REQUIRED
  return `Cursor did not report its plan usage (HTTP ${status}).`
}

export type CurrentPeriodUsage = {
  billingCycleStart?: number | undefined
  billingCycleEnd?: number | undefined
  planUsage?:
    | {
        includedSpend?: number | undefined
        limit?: number | undefined
        autoPercentUsed?: number | undefined
        apiPercentUsed?: number | undefined
        totalPercentUsed?: number | undefined
      }
    | undefined
}

/**
 * The rows `/usage` shows under "Included": the share of the plan used, then
 * its Auto and API parts when Cursor reports them, which end with the same
 * billing cycle. Without plan usage (Enterprise spend accounts) the CLI says
 * usage is not available for the plan, and so does this.
 */
export function cursorLimitsFromUsage(usage: CurrentPeriodUsage): CursorLimitSource {
  const plan = usage.planUsage
  if (plan === undefined) return { status: 'unavailable' }
  const start = usage.billingCycleStart
  const end = usage.billingCycleEnd
  const window =
    start !== undefined && end !== undefined && end > start
      ? Math.round((end - start) / 60_000)
      : undefined
  const timing = {
    ...(end !== undefined && end > 0 ? { resetsAt: end } : {}),
    ...(window !== undefined && window > 0 ? { windowMinutes: window } : {}),
  }
  // The CLI's own fallback when the percentage is absent.
  const total =
    plan.totalPercentUsed ??
    (plan.limit !== undefined && plan.limit > 0
      ? ((plan.includedSpend ?? 0) / plan.limit) * 100
      : undefined)
  const rows: ProviderLimit[] = []
  // Auto and API are parts of Included and end with the same cycle; only
  // Included carries the reset, so the popup says it once.
  const add = (id: string, label: string, percent: number | undefined, timed: boolean) => {
    if (percent === undefined || !Number.isFinite(percent)) return
    const usedPercent = Math.max(0, Math.min(100, percent))
    rows.push({ id, label, usedPercent, ...(timed ? timing : {}) })
  }
  add('included', 'Included', total, true)
  add('auto', 'Auto', plan.autoPercentUsed, false)
  add('api', 'API', plan.apiPercentUsed, false)
  return rows.length > 0 ? { status: 'ready', limits: rows } : { status: 'unavailable' }
}

/**
 * Reads `aiserver.v1.GetCurrentPeriodUsageResponse` from its protobuf bytes.
 * Field numbers and types are the bundle's own (`index.js` ~7682025):
 * 1 billing_cycle_start int64, 2 billing_cycle_end int64, 3 plan_usage; in
 * PlanUsage 2 included_spend int32, 5 limit int32, 12 auto_percent_used,
 * 13 api_percent_used, 14 total_percent_used doubles. Everything else is
 * skipped.
 */
export function decodeCurrentPeriodUsage(bytes: Uint8Array): CurrentPeriodUsage {
  const usage: CurrentPeriodUsage = {}
  for (const field of protoFields(bytes)) {
    if (field.number === 1 && field.varint !== undefined) usage.billingCycleStart = field.varint
    else if (field.number === 2 && field.varint !== undefined) usage.billingCycleEnd = field.varint
    else if (field.number === 3 && field.bytes !== undefined) {
      const plan: NonNullable<CurrentPeriodUsage['planUsage']> = {}
      for (const inner of protoFields(field.bytes)) {
        if (inner.number === 2 && inner.varint !== undefined) plan.includedSpend = inner.varint
        else if (inner.number === 5 && inner.varint !== undefined) plan.limit = inner.varint
        else if (inner.number === 12 && inner.double !== undefined)
          plan.autoPercentUsed = inner.double
        else if (inner.number === 13 && inner.double !== undefined)
          plan.apiPercentUsed = inner.double
        else if (inner.number === 14 && inner.double !== undefined)
          plan.totalPercentUsed = inner.double
      }
      usage.planUsage = plan
    }
  }
  return usage
}

type ProtoField = {
  number: number
  varint?: number | undefined
  double?: number | undefined
  bytes?: Uint8Array | undefined
}

function protoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let at = 0
  const varint = (): bigint => {
    let result = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= bytes.length) throw new Error('Cursor sent a truncated answer.')
      const byte = bytes[at++]!
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
    }
    throw new Error('Cursor sent a malformed answer.')
  }
  while (at < bytes.length) {
    const key = varint()
    const number = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (wire === 0) {
      // int32 and int64 alike; a negative int32 arrives as ten bytes.
      fields.push({ number, varint: Number(BigInt.asIntN(64, varint())) })
    } else if (wire === 1) {
      if (at + 8 > bytes.length) throw new Error('Cursor sent a truncated answer.')
      const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8)
      fields.push({ number, double: view.getFloat64(0, true) })
      at += 8
    } else if (wire === 2) {
      const length = Number(varint())
      if (at + length > bytes.length) throw new Error('Cursor sent a truncated answer.')
      fields.push({ number, bytes: bytes.subarray(at, at + length) })
      at += length
    } else if (wire === 5) {
      at += 4
    } else {
      throw new Error('Cursor sent a malformed answer.')
    }
  }
  return fields
}
