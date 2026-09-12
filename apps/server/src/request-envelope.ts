import type { ParamsOf, Request } from '@harness/contracts'

/** Validates the small RPC envelope before the method-specific schema runs. */
export function parseRequestEnvelope(value: unknown): Request | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const envelope = value as Record<string, unknown>
  if (
    typeof envelope['id'] !== 'string' ||
    typeof envelope['method'] !== 'string' ||
    !('params' in envelope)
  ) {
    return undefined
  }
  return { id: envelope['id'], method: envelope['method'], params: envelope['params'] }
}

type FrequentMethod = 'terminal.input' | 'terminal.resize'

/** Fast success path for terminal traffic; invalid data falls back to the full schema. */
export function parseFrequentMethodParams<M extends FrequentMethod>(
  method: M,
  value: unknown,
): ParamsOf<M> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const params = value as Record<string, unknown>
  const terminalId = params['terminalId']
  if (typeof terminalId !== 'string' || terminalId.length === 0) return undefined

  if (method === 'terminal.input') {
    const data = params['data']
    if (typeof data !== 'string' || data.length > 65_536) return undefined
    return { terminalId, data } as ParamsOf<M>
  }

  const columns = params['columns']
  const rows = params['rows']
  if (!validTerminalDimension(columns) || !validTerminalDimension(rows)) return undefined
  return { terminalId, columns, rows } as ParamsOf<M>
}

function validTerminalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000
}
