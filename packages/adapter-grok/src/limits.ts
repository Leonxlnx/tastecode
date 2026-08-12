import { spawn } from 'node:child_process'
import { StdioJsonRpc } from '@harness/proc'
import { grokCommand } from './adapter.js'

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

/** Pure mapping so the billing shape is testable without the network. */
export function mapGrokBilling(body: unknown): ProviderLimit[] {
  if (typeof body !== 'object' || body === null) return []
  const config = (body as Record<string, unknown>)['config']
  if (typeof config !== 'object' || config === null) return []
  const record = config as Record<string, unknown>
  const period = record['currentPeriod'] as Record<string, unknown> | undefined
  if (period?.['type'] !== 'USAGE_PERIOD_TYPE_WEEKLY') return []
  const rawPercent = record['creditUsagePercent'] ?? 0
  const numeric =
    typeof rawPercent === 'string' && rawPercent.trim() ? Number(rawPercent) : rawPercent
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return []
  const end = typeof period['end'] === 'string' ? Date.parse(period['end']) : Number.NaN
  return [
    {
      label: 'Weekly limit',
      usedPercent: Math.max(0, Math.min(100, numeric)),
      ...(Number.isFinite(end) ? { resetsAt: end } : {}),
    },
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
