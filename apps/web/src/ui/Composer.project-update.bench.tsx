// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { afterAll, bench, describe, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { Transport } from '../transport.js'
import { createProjectChoiceProjector, type ProjectChoice } from '../project-choices.js'
import { Composer } from './Composer.js'
import type { Project } from './Sidebar.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const noop = () => undefined
const transcribe = async () => ''
const transport = {
  state: 'open',
  connect: noop,
  close: noop,
  ensureHealthy: async () => undefined,
  request: vi.fn(async () => ({ capabilities: {}, skills: [], servers: [], errors: [] })),
  on: vi.fn(() => noop),
  onState: vi.fn(() => noop),
  onSequenceGap: vi.fn(() => noop),
} as Transport
const projects: Project[] = Array.from({ length: 100 }, (_, index) => ({
  path: `/project-${index}`,
  name: `Project ${index}`,
  sessions: [],
}))
const statusUpdatedProjects = projects.map((project, index) =>
  index === 50 ? { ...project, sessions: [...project.sessions] } : project,
)
const props = {
  transport,
  provider: 'codex',
  projectPath: '/project-0',
  projectName: 'Project 0',
  branch: 'main',
  branches: ['main'],
  models: [],
  modelsLoaded: true,
  modelId: undefined,
  effort: undefined,
  serviceTier: undefined,
  approval: 'ask',
  autoReviewSupported: false,
  attachmentsSupported: true,
  voiceAvailable: false,
  disabled: false,
  sendAvailability: 'ready',
  running: false,
  newSession: false,
  isolate: false,
  designMode: false,
  focusRequest: 0,
  queuedTurns: [],
  canSteerQueue: false,
  onModelChange: noop,
  onEffortChange: noop,
  onServiceTierChange: noop,
  onApprovalChange: noop,
  onIsolateChange: noop,
  onDesignModeChange: noop,
  onTranscribeVoice: transcribe,
  onCancelVoice: noop,
  onProjectChange: noop,
  onBranchChange: noop,
  onProjectRequired: noop,
  onSetupProvider: noop,
  onSend: noop,
  onSteer: noop,
  onInterrupt: noop,
  onDeleteQueuedTurn: noop,
  onMoveQueuedTurn: noop,
  onSteerQueuedTurn: noop,
} satisfies Omit<ComponentProps<typeof Composer>, 'projects'>

function view(source: ReadonlyArray<ProjectChoice>) {
  return <Composer {...props} projects={source} />
}

const churned = render(view(projects))
const retained = render(view(projects))
let frame = 0
const projectChoices = createProjectChoiceProjector()
projectChoices(projects)

afterAll(() => {
  churned.unmount()
  retained.unmount()
})

describe('background project status update while composing', () => {
  bench(
    'rerenders Composer for a status-only project tree change',
    () => {
      frame = frame === 0 ? 1 : 0
      churned.rerender(view(frame === 0 ? projects : statusUpdatedProjects))
    },
    OPTIONS,
  )

  bench(
    'skips Composer when its project choices retain identity',
    () => {
      frame = frame === 0 ? 1 : 0
      const source = frame === 0 ? projects : statusUpdatedProjects
      retained.rerender(view(projectChoices(source)))
    },
    OPTIONS,
  )
})
