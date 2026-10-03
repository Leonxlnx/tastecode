// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerVoiceControl } from './ComposerVoiceControl.js'

const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  durationMs: 1_000,
  levels: [],
}))
vi.mock('../voice-recorder.js', () => ({
  useVoiceRecorder: () => recorder,
  describeMicrophoneError: (error: Error) => error.message,
  formatRecordingDuration: () => '0:01',
  MAX_RECORDING_MS: 120_000,
}))
beforeEach(() => {
  recorder.start.mockResolvedValue(undefined)
  recorder.stop.mockResolvedValue({
    audioBase64: 'audio',
    mimeType: 'audio/wav',
    sampleRateHz: 24_000,
    durationMs: 1000,
  })
  recorder.cancel.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('voice draft ownership', () => {
  it.each([false, true])(
    'discards a late transcript after switching chats (send: %s)',
    async (sendAfter) => {
      let finish!: (text: string) => void
      const onTranscribeVoice = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
      )
      const onTranscript = vi.fn()
      const onCancelVoice = vi.fn()
      const props = {
        disabled: false,
        running: false,
        getCursor: () => 0,
        onStateChange: vi.fn(),
        onError: vi.fn(),
        onTranscript,
        onTranscribeVoice,
        onCancelVoice,
      }
      const view = render(<ComposerVoiceControl {...props} contextKey="chat-a" />)
      fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
      fireEvent.click(
        await screen.findByRole('button', {
          name: sendAfter ? 'Transcribe and send voice note' : 'Stop and transcribe voice note',
        }),
      )
      await screen.findByRole('button', { name: 'Cancel transcription' })
      view.rerender(<ComposerVoiceControl {...props} contextKey="chat-b" />)
      await act(async () => finish('Private words from chat A'))
      expect(onCancelVoice).toHaveBeenCalledWith(expect.any(String))
      expect(onTranscript).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Record voice note' })).toBeTruthy()
    },
  )

  it('cancels a recording on a draft switch before Stop can use the new chat', async () => {
    const props = {
      disabled: false,
      running: false,
      getCursor: () => 0,
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onTranscript: vi.fn(),
      onTranscribeVoice: vi.fn(),
      onCancelVoice: vi.fn(),
    }
    const view = render(<ComposerVoiceControl {...props} contextKey="chat-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
    await screen.findByRole('button', { name: 'Stop and transcribe voice note' })
    view.rerender(<ComposerVoiceControl {...props} contextKey="chat-b" />)
    expect(recorder.cancel).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Stop and transcribe voice note' })).toBeNull()
    expect(props.onTranscribeVoice).not.toHaveBeenCalled()
  })

  it('does not revive microphone startup after its owner changed', async () => {
    let finish!: () => void
    recorder.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    const props = {
      disabled: false,
      running: false,
      getCursor: () => 0,
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onTranscript: vi.fn(),
      onTranscribeVoice: vi.fn(),
      onCancelVoice: vi.fn(),
    }
    const view = render(<ComposerVoiceControl {...props} contextKey="chat-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Record voice note' }))
    view.rerender(<ComposerVoiceControl {...props} contextKey="chat-b" />)
    await act(async () => finish())
    expect(props.onStateChange).toHaveBeenLastCalledWith('idle')
    expect(screen.getByRole('button', { name: 'Record voice note' })).toBeTruthy()
  })
})
