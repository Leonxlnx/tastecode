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

  return {
    threadId: data['threadId'],
    event: {
      type: 'item.delta',
      turnId: event['turnId'],
      itemId: event['itemId'],
      textDelta: event['textDelta'],
    },
    ...(sequence === undefined ? {} : { seq: sequence }),
  }
}

export function parseMethodResult<M extends MethodName>(method: M, value: unknown): ResultOf<M> {
  if (method === 'projects.list') {
    const projects = parseProjectsListResult(value)
    if (projects) return projects as ResultOf<M>
  }
  // SAFETY: The result schema indexed by this same method validates the value before it is returned.
  return methods[method].result.parse(value) as ResultOf<M>
}

/** Validate the largest common response without making a second 10,000-row object graph. */
export function parseProjectsListResult(value: unknown): ResultOf<'projects.list'> | undefined {
  if (!isRecord(value) || !Array.isArray(value['projects'])) return undefined
  for (const project of value['projects']) {
    if (
      !isRecord(project) ||
      typeof project['path'] !== 'string' ||
      typeof project['name'] !== 'string' ||
      typeof project['pinned'] !== 'boolean' ||
      !isFiniteNumber(project['createdAt']) ||
      !Array.isArray(project['sessions'])
    ) {
      return undefined
    }
    for (const session of project['sessions']) {
      if (
        !isRecord(session) ||
        typeof session['id'] !== 'string' ||
        typeof session['title'] !== 'string' ||
        !isProviderId(session['provider']) ||
        !isOptionalString(session['agent']) ||
        !isFiniteNumber(session['createdAt']) ||
        typeof session['running'] !== 'boolean' ||
        !isOptionalBoolean(session['pinned']) ||
        !isOptionalInboxStatus(session['status']) ||
        !isOptionalBoolean(session['unread']) ||
        !isOptionalLifecycle(session['lifecycle']) ||
        !isOptionalFiniteNumber(session['closedAt']) ||
        !isOptionalString(session['worktreeBranch'])
      ) {
        return undefined
      }
    }
  }
  return value as ResultOf<'projects.list'>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function isProviderId(value: unknown): boolean {
  return (
    value === 'codex' ||
    value === 'claude-code' ||
    value === 'grok' ||
    value === 'cursor' ||
    value === 'opencode' ||
    value === 'antigravity' ||
    value === 'pi' ||
    value === 'acp' ||
    value === 'api'
  )
}

function isOptionalInboxStatus(value: unknown): boolean {
  return (
    value === undefined ||
    value === 'starting' ||
    value === 'working' ||
    value === 'queued' ||
    value === 'approval' ||
    value === 'input' ||
    value === 'failed' ||
    value === 'ready' ||
    value === 'idle'
  )
}

function isOptionalLifecycle(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value['state'] === 'active') {
    return (
      typeof value['keepActive'] === 'boolean' &&
      (value['wokeAt'] === undefined || isNonnegativeInteger(value['wokeAt']))
    )
  }
  if (value['state'] === 'settled') {
    return (
      isNonnegativeInteger(value['settledAt']) &&
      (value['reason'] === 'manual' ||
        value['reason'] === 'inactivity' ||
        value['reason'] === 'change_request')
    )
  }
  return (
    value['state'] === 'snoozed' &&
    isNonnegativeInteger(value['snoozedAt']) &&
    isNonnegativeInteger(value['wakeAt'])
  )
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
