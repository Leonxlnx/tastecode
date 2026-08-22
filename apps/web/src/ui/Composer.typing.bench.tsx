// @vitest-environment happy-dom
import { fireEvent, render } from '@testing-library/react'
import { afterAll, bench, describe, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { Composer } from './Composer.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const KEYSTROKES = 50
const noop = () => undefined
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

const view = render(
  <Composer
    transport={transport}
    provider="codex"
    projects={[{ path: '/work/harness', name: 'TasteCode', sessions: [] }]}
    projectPath="/work/harness"
    projectName="TasteCode"
    branch="main"
    branches={['main']}
    models={[]}
    modelsLoaded
    modelId={undefined}
    effort={undefined}
    serviceTier={undefined}
    approval="ask"
    autoReviewSupported={false}
    attachmentsSupported
    voiceAvailable={false}
    disabled={false}
    sendAvailability="ready"
    running={false}
    newSession={false}
    isolate={false}
    designMode={false}
    focusRequest={0}
    queuedTurns={[]}
    canSteerQueue={false}
    onModelChange={noop}
    onEffortChange={noop}
    onServiceTierChange={noop}
    onApprovalChange={noop}
    onIsolateChange={noop}
    onDesignModeChange={noop}
    onTranscribeVoice={async () => ''}
    onCancelVoice={noop}
    onProjectChange={noop}
    onBranchChange={noop}
    onProjectRequired={noop}
    onSetupProvider={noop}
    onSend={noop}
    onSteer={noop}
    onInterrupt={noop}
    onDeleteQueuedTurn={noop}
    onMoveQueuedTurn={noop}
    onSteerQueuedTurn={noop}
  />,
)

const area = view.getByPlaceholderText('Do anything') as HTMLTextAreaElement
let layoutReads = 0
Object.defineProperty(area, 'offsetHeight', {
  configurable: true,
  get: () => {
    layoutReads += 1
    return 242
  },
})
Object.defineProperty(area, 'scrollHeight', {
  configurable: true,
  get: () => {
    layoutReads += 1
    return 10_000
  },
})

let value = 'ordinary words '.repeat(10_000)
fireEvent.input(area, { target: { value }, inputType: 'insertText', data: 'x' })
layoutReads = 0

function typeBurst(): void {
  value += ' '
  fireEvent.input(area, { target: { value }, inputType: 'insertText', data: ' ' })
  for (let index = 0; index < KEYSTROKES; index += 1) {
    value += 'x'
    fireEvent.input(area, { target: { value }, inputType: 'insertText', data: 'x' })
  }
}

afterAll(() => view.unmount())

describe('capped long-draft composer typing', () => {
  bench('processes one space and 50 letters', typeBurst, OPTIONS)

  bench(
    'layout reads for one space and 50 letters',
    () => {
      const before = layoutReads
      typeBurst()
      if (layoutReads !== before) throw new Error(`benchmark read layout ${layoutReads - before}×`)
    },
    OPTIONS,
  )
})
