import { bench, describe } from 'vitest'
import { findSession, updateSession } from '../project-store.js'
import type { Project, Session } from './Sidebar.js'
import {
  classifyInboxEntries,
  createInboxEntryClassifier,
  inboxClockDelay,
} from './InboxSidebar.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }

function session(id: string, index: number): Session {
  const lifecycle: Session['lifecycle'] =
    index % 3 === 0
      ? { state: 'active', keepActive: false }
      : index % 3 === 1
        ? { state: 'snoozed', snoozedAt: index, wakeAt: 20_000 - index }
        : { state: 'settled', settledAt: index, reason: 'manual' }
  return {
    id,
    title: id,
    provider: 'codex',
    createdAt: index,
    status: 'idle',
    lifecycle,
    unread: false,
  }
}

const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => {
    const index = projectIndex * 100 + sessionIndex
    return session(`thread-${projectIndex}-${sessionIndex}`, index)
  }),
}))
const updatedProjects = projects.map((project, projectIndex) =>
  projectIndex === 50
    ? {
        ...project,
        sessions: project.sessions.map((entry, sessionIndex) =>
          sessionIndex === 50
            ? {
                ...entry,
                lifecycle: {
                  state: 'settled' as const,
                  settledAt: 30_000,
                  reason: 'manual' as const,
                },
              }
            : entry,
        ),
      }
    : project,
)
const classifyRetained = createInboxEntryClassifier()
classifyRetained(projects, '', '')
let retainedSnapshot = 0
const oneProject: Project[] = [
  {
    path: '/one-large-project',
    sessions: Array.from({ length: 10_000 }, (_, index) => ({
      ...session(`large-thread-${index}`, index * 3),
      lifecycle: { state: 'active' as const, keepActive: false },
    })),
  },
]
const copiedOneProject: Project[] = [
  {
    ...oneProject[0]!,
    sessions: oneProject[0]!.sessions.map((entry, index) =>
      index === 9_999 ? { ...entry, status: 'working' as const } : entry,
    ),
  },
]
const classifyCopiedOneProject = createInboxEntryClassifier()
classifyCopiedOneProject(oneProject, '', '')
let copiedSnapshot = false
const classifyIndexedOneProject = createInboxEntryClassifier()
classifyIndexedOneProject(oneProject, '', '')
let indexedOneProject = oneProject
const selectedSessionId = 'thread-0-0'
const orderedEntries = classifyInboxEntries(projects, '', '').ordered
findSession(projects, selectedSessionId)
const IDLE_DAY_MS = 24 * 60 * 60 * 1_000
const idleDayStart = new Date(2026, 7, 21, 12).getTime()
const idleRelativeTimes = Array.from(
  { length: 35 },
  (_, index) => idleDayStart - 10 * IDLE_DAY_MS - (index * IDLE_DAY_MS) / 35,
)
let idleClockChecksum = 0

function refreshIdleLabels(now: number): void {
  let checksum = 0
  for (const timestamp of idleRelativeTimes) {
    checksum += Math.round((now - timestamp) / 1_000)
  }
  idleClockChecksum ^= checksum
}

function countFixedMinuteIdleWakeups(): number {
  let now = idleDayStart
  let wakeups = 0
  while (now < idleDayStart + IDLE_DAY_MS) {
    const delay = 60_000
    now += delay
    refreshIdleLabels(now)
    wakeups += 1
  }
  return wakeups
}

function countAdaptiveIdleWakeups(): number {
  let now = idleDayStart
  let wakeups = 0
  while (now < idleDayStart + IDLE_DAY_MS) {
    const delay = inboxClockDelay(false, idleRelativeTimes, false, now)
    if (delay === undefined) break
    now += delay
    refreshIdleLabels(now)
    wakeups += 1
  }
  return wakeups
}

function legacyClassify(projects: Project[]) {
  const entries = projects.flatMap((project) =>
    project.sessions.map((session) => ({ project, session })),
  )
  const active = entries
    .filter((entry) => entry.session.lifecycle.state === 'active')
    .sort((left, right) => right.session.createdAt - left.session.createdAt)
  const snoozed = entries
    .filter((entry) => entry.session.lifecycle.state === 'snoozed')
    .sort((left, right) => wakeAt(left.session) - wakeAt(right.session))
  const settled = entries
    .filter((entry) => entry.session.lifecycle.state === 'settled')
    .sort((left, right) => settledAt(right.session) - settledAt(left.session))
  return [...active, ...snoozed, ...settled]
}

function wakeAt(session: Session): number {
  return session.lifecycle.state === 'snoozed' ? session.lifecycle.wakeAt : 0
}

function settledAt(session: Session): number {
  return session.lifecycle.state === 'settled' ? session.lifecycle.settledAt : 0
}

describe('many-thread inbox classification', () => {
  bench(
    'legacy multi-pass classification for 10,000 sessions',
    () => {
      legacyClassify(projects)
    },
    OPTIONS,
  )

  bench(
    'single-pass classification for 10,000 sessions',
    () => {
      classifyInboxEntries(projects, '', '')
    },
    OPTIONS,
  )

  bench(
    're-sorts 10,000 sessions after one status update',
    () => {
      classifyInboxEntries(updatedProjects, '', '')
    },
    OPTIONS,
  )

  bench(
    'moves one retained row after one status update',
    () => {
      retainedSnapshot = retainedSnapshot === 0 ? 1 : 0
      classifyRetained(retainedSnapshot === 0 ? projects : updatedProjects, '', '')
    },
    OPTIONS,
  )
})

describe('one-project status updates', () => {
  bench(
    'discovers one changed row by scanning 10,000 session slots',
    () => {
      copiedSnapshot = !copiedSnapshot
      classifyCopiedOneProject(copiedSnapshot ? copiedOneProject : oneProject, '', '')
    },
    OPTIONS,
  )

  bench(
    'uses the exact immutable update location',
    () => {
      indexedOneProject = updateSession(indexedOneProject, 'large-thread-9999', (entry) => ({
        ...entry,
        status: entry.status === 'working' ? 'idle' : 'working',
      }))
      classifyIndexedOneProject(indexedOneProject, '', '')
    },
    OPTIONS,
  )
})

describe('many-thread active selection', () => {
  bench(
    'scans 10,000 classified rows for the active thread',
    () => {
      const selected = orderedEntries.find((entry) => entry.session.id === selectedSessionId)
      if (!selected) throw new Error('missing selected thread')
    },
    OPTIONS,
  )

  bench(
    'uses the retained session location for the active thread',
    () => {
      const selected = findSession(projects, selectedSessionId)
      if (!selected) throw new Error('missing selected thread')
    },
    OPTIONS,
  )
})

describe('idle inbox clock', () => {
  bench(
    'wakes every minute through one idle day',
    () => {
      if (countFixedMinuteIdleWakeups() !== 1_440) throw new Error('invalid idle wake count')
    },
    OPTIONS,
  )

  bench(
    'wakes only when one of 35 old labels changes',
    () => {
      if (countAdaptiveIdleWakeups() !== 36) throw new Error('invalid adaptive wake count')
    },
    OPTIONS,
  )
})
