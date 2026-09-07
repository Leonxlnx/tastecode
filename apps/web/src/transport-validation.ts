import {
  PreviewCaptureRequestSchema,
  channels,
  methods,
  type ChannelName,
  type DataOf,
  type MethodName,
  type PreviewCaptureRequest,
  type ResultOf,
} from '@harness/contracts'
import { parseStartupMethodResult } from './transport-startup-validation.js'

export { parseProjectsListResult } from './transport-startup-validation.js'

export function parsePreviewCaptureRequest(value: unknown): PreviewCaptureRequest | undefined {
  const request = PreviewCaptureRequestSchema.safeParse(value)
  return request.success ? request.data : undefined
}

export function parseChannelData<C extends ChannelName>(channel: C, value: unknown): DataOf<C> {
  if (channel === 'thread.event' || channel === 'sideChat.event') {
    const delta = parseThreadDeltaData(value)
    if (delta) return delta as DataOf<C>
  }
  if (channel === 'terminal.output') {
    const output = parseTerminalOutputData(value)
    if (output) return output as DataOf<C>
  }
  // SAFETY: The schema indexed by this same channel validates the value before it is returned.
  return channels[channel].parse(value) as DataOf<C>
}

function parseTerminalOutputData(value: unknown): DataOf<'terminal.output'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const output = value as Record<string, unknown>
  if (
    typeof output['terminalId'] !== 'string' ||
    output['terminalId'].length === 0 ||
    typeof output['data'] !== 'string'
  ) {
    return undefined
  }

  return { terminalId: output['terminalId'], data: output['data'] }
}

function parseThreadDeltaData(value: unknown): DataOf<'thread.event'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const data = value as Record<string, unknown>
  const eventValue = data['event']
  if (
    typeof data['threadId'] !== 'string' ||
    typeof eventValue !== 'object' ||
    eventValue === null
  ) {
    return undefined
  }
  const event = eventValue as Record<string, unknown>
  if (
    event['type'] !== 'item.delta' ||
    typeof event['turnId'] !== 'string' ||
    typeof event['itemId'] !== 'string' ||
    typeof event['textDelta'] !== 'string'
  ) {
    return undefined
  }
  const sequence = data['seq']
  if (sequence !== undefined && (typeof sequence !== 'number' || !Number.isFinite(sequence))) {
    return undefined
  }

  const parsedEvent = {
    type: 'item.delta' as const,
    turnId: event['turnId'],
    itemId: event['itemId'],
    textDelta: event['textDelta'],
  }
  return sequence === undefined
    ? { threadId: data['threadId'], event: parsedEvent }
    : { threadId: data['threadId'], event: parsedEvent, seq: sequence }
}

export function parseMethodResult<M extends MethodName>(method: M, value: unknown): ResultOf<M> {
  const startupResult = parseStartupMethodResult(method, value)
  if (startupResult !== undefined) return startupResult
  // SAFETY: The result schema indexed by this same method validates the value before it is returned.
  return methods[method].result.parse(value) as ResultOf<M>
}
