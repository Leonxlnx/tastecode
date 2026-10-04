import { boundedInteger, member, record, string } from './parse.js'
export const DESIGN_PHASES = [
  'brief',
  'brand',
  'page',
  'assets',
  'build',
  'preview',
  'review',
] as const

export type DesignPhase = (typeof DESIGN_PHASES)[number]
export type DesignRunPhase = DesignPhase | 'complete'
export type DesignRunStatus = 'running' | 'waiting' | 'failed' | 'complete'

export interface DesignRunState {
  version: 1
  phase: DesignRunPhase
  status: DesignRunStatus
  completed: DesignPhase[]
  attempts: {
    build: number
    preview: number
    review: number
  }
  error?: {
    phase: DesignPhase
    message: string
  }
}

export function createDesignRunState(): DesignRunState {
  return {
    version: 1,
    phase: 'brief',
    status: 'running',
    completed: [],
    attempts: { build: 0, preview: 0, review: 0 },
  }
}

export function nextDesignPhase(completed: readonly DesignPhase[]): DesignRunPhase {
  validateCompleted(completed)
  return DESIGN_PHASES[completed.length] ?? 'complete'
}

export function parseDesignRunState(value: unknown): DesignRunState {
  const state = record(value, 'design run')
  if (state.version !== 1) throw new Error('design run version must be 1')
  if (!Array.isArray(state.completed)) throw new Error('design run completed must be an array')

  const completed = state.completed.map((phase, index) =>
    member(phase, DESIGN_PHASES, `design run completed[${index}]`),
  )
  const expectedPhase = nextDesignPhase(completed)
  const phase = member(state.phase, [...DESIGN_PHASES, 'complete'] as const, 'design run phase')
  const status = member(
    state.status,
    ['running', 'waiting', 'failed', 'complete'] as const,
    'design run status',
  )
  if (phase !== expectedPhase) throw new Error(`design run phase must be ${expectedPhase}`)
  if ((status === 'complete') !== (phase === 'complete')) {
    throw new Error('only the complete phase may use complete status')
  }

  const attempts = record(state.attempts, 'design run attempts')
  const error = optionalError(state.error)
  if ((status === 'failed') !== Boolean(error)) {
    throw new Error('failed design runs must contain exactly one error')
  }

  return {
    version: 1,
    phase,
    status,
    completed,
    attempts: {
      build: count(attempts.build, 'design run attempts.build'),
      preview: count(attempts.preview, 'design run attempts.preview'),
      review: count(attempts.review, 'design run attempts.review'),
    },
    ...(error ? { error } : {}),
  }
}

function validateCompleted(completed: readonly DesignPhase[]): void {
  for (let index = 0; index < completed.length; index++) {
    if (completed[index] !== DESIGN_PHASES[index]) {
      throw new Error('completed design phases must be a contiguous prefix')
    }
  }
  if (completed.length > DESIGN_PHASES.length) {
    throw new Error('completed design phases exceed the workflow')
  }
}

function optionalError(value: unknown): DesignRunState['error'] {
  if (value === undefined) return undefined
  const error = record(value, 'design run error')
  return {
    phase: member(error.phase, DESIGN_PHASES, 'design run error.phase'),
    message: string(error.message, 'design run error.message'),
  }
}

function count(value: unknown, field: string): number {
  const result = boundedInteger(value, 0, Number.MAX_SAFE_INTEGER)
  if (result === undefined) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return result
}
