// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { Composer, insertTranscriptAtCursor } from './Composer.js'

const recorder = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => ({
    audioBase64: 'UklGRg==',
    mimeType: 'audio/wav' as const,
    sampleRateHz: 24_000 as const,
    durationMs: 1_000,
  })),
  cancel: vi.fn(async () => undefined),
  durationMs: 1_000,
  levels: [0.2, 0.8],
}))

vi.mock('../voice-recorder.js', () => ({
  MAX_RECORDING_MS: 120_000,
  describeMicrophoneError: (error: Error) =>
    error.name === 'NotAllowedError' ? 'Microphone access was denied.' : error.message,
  formatRecordingDuration: () => '0:01',
  useVoiceRecorder: () => ({ ...recorder, recording: false }),
}))

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('Composer voice dictation', () => {
  it('records, transcribes, and inserts at the cursor without sending', async () => {
    const onSend = vi.fn()
    const onTranscribeVoice = vi.fn(async () => 'spoken words')
    const onDraftChange = vi.fn()
    renderVoiceComposer({ onSend, onTranscribeVoice, onDraftChange })
    const textarea = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello world' } })
    textarea.setSelectionRange(5, 5)

    fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe voice note' }))

    await waitFor(() => expect(textarea.value).toBe('hello spoken words world'))
    expect(onTranscribeVoice).toHaveBeenCalledTimes(1)
    expect(onDraftChange).toHaveBeenLastCalledWith('hello spoken words world')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('transcribes and sends from the arrow action', async () => {
    const onSend = vi.fn()
    const onTranscribeVoice = vi.fn(async () => 'spoken words')
    renderVoiceComposer({ onSend, onTranscribeVoice })

    fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe and send voice note' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('spoken words', []))
    expect(onTranscribeVoice).toHaveBeenCalledTimes(1)
  })

  it('keeps a send-after transcript as a draft when the provider is not ready', async () => {
    const onSend = vi.fn()
    renderVoiceComposer({
      onSend,
      onTranscribeVoice: vi.fn(async () => 'spoken words'),
      sendAvailability: 'setup-required',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe and send voice note' }))

    await waitFor(() =>
      expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
        'spoken words',
      ),
    )
    expect(onSend).not.toHaveBeenCalled()
  })

  it('cancels an in-flight transcription by request id', async () => {
    const onCancelVoice = vi.fn()
    const onTranscribeVoice = vi.fn(() => new Promise<string>(() => {}))
    renderVoiceComposer({ onTranscribeVoice, onCancelVoice })

    fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and transcribe voice note' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel transcription' }))

    expect(onCancelVoice).toHaveBeenCalledWith(expect.any(String))
    expect(screen.getByRole('button', { name: 'Record voice note' })).toBeTruthy()
  })

  it('shows an actionable microphone permission error', async () => {
    const denied = new Error('denied')
    denied.name = 'NotAllowedError'
    recorder.start.mockRejectedValueOnce(denied)
    renderVoiceComposer()

    fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Microphone access was denied.',
    )
  })
})

describe('insertTranscriptAtCursor', () => {
  it('inserts without replacing either side of the draft', () => {
    expect(insertTranscriptAtCursor('hello world', 'spoken', 5)).toEqual({
      text: 'hello spoken world',
      cursor: 12,
    })
  })
})

function renderVoiceComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer
      projects={[{ path: '/work/harness', name: 'Harness', sessions: [] }]}
      projectPath="/work/harness"
      projectName="Harness"
      branch="main"
      branches={['main']}
      models={[]}
      modelsLoaded
      modelId={undefined}
      effort={undefined}
      serviceTier={undefined}
      approval="ask"
      autoReviewSupported={false}
      voiceAvailable
      disabled={false}
      sendAvailability="ready"
      running={false}
      newSession
      isolate={false}
      designMode={false}
      focusRequest={0}
      queuedTurns={[]}
      canSteerQueue={false}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onServiceTierChange={vi.fn()}
      onApprovalChange={vi.fn()}
      onIsolateChange={vi.fn()}
      onDesignModeChange={vi.fn()}
      onProjectChange={vi.fn()}
      onBranchChange={vi.fn()}
      onProjectRequired={vi.fn()}
      onSetupProvider={vi.fn()}
      onTranscribeVoice={vi.fn()}
      onCancelVoice={vi.fn()}
      onSend={vi.fn()}
      onSteer={vi.fn()}
      onInterrupt={vi.fn()}
      onDeleteQueuedTurn={vi.fn()}
      onMoveQueuedTurn={vi.fn()}
      onSteerQueuedTurn={vi.fn()}
      {...overrides}
    />,
  )
}
