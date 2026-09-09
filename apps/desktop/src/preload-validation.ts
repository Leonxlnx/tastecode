import type { AppUpdateState } from './app-updater.js'

function isUpdateStatus(value: unknown): value is AppUpdateState['status'] {
  switch (value) {
    case 'unsupported':
    case 'manual':
    case 'idle':
    case 'checking':
    case 'downloading':
    case 'current':
    case 'ready':
    case 'error':
      return true
    default:
      return false
  }
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isAppUpdateState(value: unknown): value is AppUpdateState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return (
    isUpdateStatus(state['status']) &&
    typeof state['currentVersion'] === 'string' &&
    (state['version'] === undefined || typeof state['version'] === 'string') &&
    (state['progress'] === undefined || isFiniteNumber(state['progress'])) &&
    (state['error'] === undefined || typeof state['error'] === 'string')
  )
}
