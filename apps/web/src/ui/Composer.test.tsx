// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from './Composer.js'

vi.mock('../bridge.js', () => ({
  canDictate: false,
  pickFiles: vi.fn(async () => []),
  startDictation: vi.fn(),
}))

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:pasted-image'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Composer image paste', () => {
  it('previews a pasted image and sends its materialized path', async () => {
    const onSend = vi.fn()
    const savePastedImage = vi.fn(async () => '/tmp/pasted-image.png')
    renderComposer(onSend, savePastedImage)
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })

    expect(screen.getByRole('button', { name: 'Open Screenshot.png' })).toBeTruthy()
    expect(savePastedImage).toHaveBeenCalledWith(image)
    fireEvent.change(composer, { target: { value: 'What is in this image?' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('What is in this image?', ['/tmp/pasted-image.png'])
    expect(screen.queryByRole('button', { name: 'Open Screenshot.png' })).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pasted-image')
  })

  it('removes a pasted image before sending', () => {
    renderComposer(vi.fn())
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Screenshot.png' }))

    expect(screen.queryByRole('button', { name: 'Open Screenshot.png' })).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pasted-image')
  })

  it('opens a zoomable, downloadable viewer and closes it with Escape', () => {
    renderComposer(vi.fn())
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })
    const open = screen.getByRole('button', { name: 'Open Screenshot.png' })
    open.focus()
    fireEvent.click(open)

    expect(screen.getByRole('dialog', { name: 'Preview Screenshot.png' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Screenshot.png' })).toBeTruthy()
    const download = screen.getByRole('link', { name: 'Download image' })
    expect(download.getAttribute('href')).toBe('blob:pasted-image')
    expect(download.getAttribute('download')).toBe('Screenshot.png')
    expect(screen.getByText('100%')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('125%')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Preview Screenshot.png' })).toBeNull()
    expect(document.activeElement).toBe(open)
  })
})

describe('Composer permissions', () => {
  it('shows automatic review only when the provider advertises it', () => {
    renderComposer(vi.fn())
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.queryByText('Auto-review')).toBeNull()
    cleanup()

    renderComposer(vi.fn(), undefined, true)
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.getByText('Auto-review')).toBeTruthy()
    expect(screen.getByText('Works in this folder; Codex reviews extra access')).toBeTruthy()
  })
})

function renderComposer(
  onSend: (text: string, attachments: string[]) => void,
  onSavePastedImage: ((file: File) => Promise<string>) | undefined = async () =>
    '/tmp/pasted-image.png',
  autoReviewAvailable = false,
) {
  return render(
    <Composer
      projectName="Harness"
      workspace={undefined}
      models={[]}
      modelsLoaded
      modelId={undefined}
      effort={undefined}
      serviceTier={undefined}
      approval="ask"
      autoReviewAvailable={autoReviewAvailable}
      voiceAvailable={false}
      disabled={false}
      running={false}
      focusRequest={0}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onServiceTierChange={vi.fn()}
      onApprovalChange={vi.fn()}
      onSavePastedImage={onSavePastedImage ?? (async () => '/tmp/pasted-image.png')}
      onTranscribeVoice={vi.fn()}
      onCancelVoice={vi.fn()}
      onSend={onSend}
      onInterrupt={vi.fn()}
    />,
  )
}
