import type { DomainEvent } from '@harness/contracts'

export type InboxProjection = {
  approvals?: Set<string> | undefined
  inputs?: Set<string> | undefined
  last: 'idle' | 'failed'
}

export function emptyInboxProjection(): InboxProjection {
  return { last: 'idle' }
}

export function isEmptyInboxProjection(projection: InboxProjection): boolean {
  return projection.last === 'idle' && !projection.approvals && !projection.inputs
}

export function affectsInboxProjection(event: DomainEvent): boolean {
  return (
    event.type === 'approval.requested' ||
    event.type === 'approval.resolved' ||
    event.type === 'user_input.requested' ||
    event.type === 'user_input.resolved' ||
    event.type === 'thread.error' ||
    event.type === 'turn.completed'
  )
}

export function applyInboxProjectionEvent(projection: InboxProjection, event: DomainEvent): void {
  if (event.type === 'approval.requested') {
    ;(projection.approvals ??= new Set()).add(event.request.id)
  }
  if (event.type === 'approval.resolved' && projection.approvals?.delete(event.id)) {
    if (projection.approvals.size === 0) delete projection.approvals
  }
  if (event.type === 'user_input.requested') {
    ;(projection.inputs ??= new Set()).add(event.request.id)
  }
  if (event.type === 'user_input.resolved' && projection.inputs?.delete(event.id)) {
    if (projection.inputs.size === 0) delete projection.inputs
  }
  if (event.type === 'thread.error') projection.last = 'failed'
  if (event.type === 'turn.completed') {
    projection.last = event.status === 'failed' ? 'failed' : 'idle'
  }
}
