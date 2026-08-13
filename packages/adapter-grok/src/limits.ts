import { spawn } from 'node:child_process'
import { StdioJsonRpc } from '@harness/proc'
import { grokAccount, grokCommand } from './adapter.js'

/**
 * Weekly credit pool through Grok Build's own ACP extension. The provider
 * process owns its credentials, request headers and token refresh lifecycle;
 * Harness only receives the billing response it deliberately exposes.
 */

const TIMEOUT_MS = 10_000

export type ProviderLimit = {
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  valueLabel?: string | undefined
}

export type GrokLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : undefined
}

function percent(value: unknown): number | undefined {
  const numeric = finiteNumber(value)
  return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric))
}

/** Grok's billing RPC defines signed Cent values; an empty object is proto3 zero. */
function cents(value: unknown): number | undefined {
  const record = object(value)
  if (!record) return undefined
  const numeric = finiteNumber(Object.hasOwn(record, 'val') ? record['val'] : 0)
  return numeric !== undefined && Number.isSafeInteger(numeric) ? numeric : undefined
}

function dollars(value: number): string {
  return `$${(value / 100).toFixed(2)}`
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function includedCreditsRow(config: Record<string, unknown>): ProviderLimit[] {
  const period = object(config['currentPeriod'])
  const periodType = period?.['type']
  const label =
    periodType === 'USAGE_PERIOD_TYPE_WEEKLY'
      ? 'Weekly'
      : periodType === 'USAGE_PERIOD_TYPE_MONTHLY' || (!period && config['monthlyLimit'])
        ? 'Monthly'
        : 'Included credits'
  const resetsAt = timestamp(period?.['end'] ?? config['billingPeriodEnd'])
  const usedPercent = percent(config['creditUsagePercent'])
  if (usedPercent !== undefined) {
    return [{ label, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) }]
  }

  const rawLimit = cents(config['monthlyLimit'])
  const rawUsed = cents(config['used'])
  const limit = rawLimit !== undefined && rawLimit >= 0 ? rawLimit : undefined
  const used = rawUsed !== undefined && rawUsed >= 0 ? rawUsed : undefined
  if ((limit ?? 0) > 0 || (used ?? 0) > 0) {
    const includedUsed = limit !== undefined && used !== undefined ? Math.min(used, limit) : used
    const valueLabel =
      limit !== undefined && includedUsed !== undefined
        ? `${dollars(includedUsed)} of ${dollars(limit)} used`
        : limit !== undefined
          ? `${dollars(limit)} included`
          : `${dollars(includedUsed!)} used`
    return [
      {
        label,
        usedPercent:
          limit && includedUsed !== undefined ? percent((includedUsed / limit) * 100)! : 0,
        ...(resetsAt === undefined ? {} : { resetsAt }),
        valueLabel,
      },
    ]
  }

  return period
    ? [
        {
          label,
          usedPercent: 0,
          ...(resetsAt === undefined ? {} : { resetsAt }),
          valueLabel: 'Usage not reported',
        },
      ]
    : []
}

function prepaidCreditsRow(config: Record<string, unknown>): ProviderLimit[] {
  const balance = cents(config['prepaidBalance'])
  const remaining = balance === undefined ? undefined : Math.abs(balance)
  return !remaining
    ? []
    : [{ label: 'Credits', usedPercent: 0, valueLabel: `${dollars(remaining)} remaining` }]
}

function onDemandCreditsRow(
  root: Record<string, unknown>,
  config: Record<string, unknown>,
): ProviderLimit[] {
  const enabled = root['on_demand_enabled'] ?? root['onDemandEnabled']
  if (enabled === false) return []
  const rawCap = cents(config['onDemandCap'])
  const explicitUsed = cents(config['onDemandUsed'])
  const totalUsed = cents(config['used'])
  const monthlyLimit = cents(config['monthlyLimit'])
  const rawUsed =
    explicitUsed ??
    (totalUsed !== undefined && monthlyLimit !== undefined
      ? Math.max(totalUsed - monthlyLimit, 0)
      : undefined)
  const cap = rawCap === undefined ? undefined : Math.abs(rawCap)
  const used = rawUsed === undefined ? undefined : Math.abs(rawUsed)
  const hasAmounts = (cap ?? 0) > 0 || (used ?? 0) > 0
  if (enabled !== true && !hasAmounts) return []
  const valueLabel =
    cap && used !== undefined
      ? `${dollars(used)} used of ${dollars(cap)} limit`
      : (cap ?? 0) > 0
        ? `${dollars(cap!)} limit`
        : (used ?? 0) > 0
          ? `${dollars(used!)} used`
          : 'Enabled'
  return [
    {
      label: 'Pay-as-you-go',
      usedPercent: cap && used !== undefined ? percent((used / cap) * 100)! : 0,
      valueLabel,
    },
  ]
}

/** Pure mapping so the billing shape is testable without the network. */
export function mapGrokBilling(body: unknown): ProviderLimit[] {
  const root = object(body)
  const config = object(root?.['config'])
  if (!root || !config) return []
  return [
    ...includedCreditsRow(config),
    ...prepaidCreditsRow(config),
    ...onDemandCreditsRow(root, config),
  ]
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('grok billing did not answer in time')), TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function readGrokBilling(): Promise<unknown> {
  const child = spawn(grokCommand(), ['agent', '--no-leader', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const rpc = new StdioJsonRpc(child, 'grok billing')
  try {
    await bounded(
      rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'personal-harness', version: '0.0.0' },
      }),
    )
    return await bounded(rpc.request('_x.ai/billing', {}))
  } finally {
    rpc.dispose()
  }
}

let billingRead: Promise<unknown> | undefined

function grokBilling(): Promise<unknown> {
  billingRead ??= readGrokBilling().finally(() => {
    billingRead = undefined
  })
  return billingRead
}

export async function grokLimits(): Promise<ProviderLimit[]> {
  return mapGrokBilling(await grokBilling())
}

/** Provider-local availability keeps shared code free of Grok auth checks. */
export async function grokLimitSource(
  account: typeof grokAccount = grokAccount,
): Promise<GrokLimitSource> {
  if (!(await account()).signedIn) return { status: 'unavailable' }
  const body = await grokBilling()
  if (!object(object(body)?.['config'])) throw new Error('Grok billing response was invalid.')
  return { status: 'ready', limits: mapGrokBilling(body) }
}
