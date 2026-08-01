// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from './Composer.js'

const bridge = vi.hoisted(() => ({
  savePastedImage: vi.fn(),
}))

vi.mock('../bridge.js', () => ({
  canDictate: false,
  pickFiles: vi.fn(async () => []),
  savePastedImage: bridge.savePastedImage,
  startDictation: vi.fn(),
}))

beforeEach(() => {
  bridge.savePastedImage.mockResolvedValue('/tmp/pasted-image.png')
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
    renderComposer(onSend)
    const composer = screen.getByPlaceholderText('Do anything')
    const image = new File(['image bytes'], 'Screenshot.png', { type: 'image/png' })

    fireEvent.paste(composer, { clipboardData: { files: [image] } })

    expect(screen.getByRole('button', { name: 'Open Screenshot.png' })).toBeTruthy()
    expect(bridge.savePastedImage).toHaveBeenCalledWith(image)
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

describe('Composer queue', () => {
  it('changes Stop back to Send when a running session has a draft and Enter queues it', () => {
    const onSend = vi.fn()
    const onInterrupt = vi.fn()
    renderComposer(onSend, { running: true, onInterrupt })
    const composer = screen.getByPlaceholderText('Do anything')

    const action = screen.getByRole('button', { name: 'Stop' })
    fireEvent.change(composer, { target: { value: 'Do this next' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBe(action)
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('Do this next', [])
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBe(action)
    expect(action.classList.contains('is-sending')).toBe(true)
  })

  it('offers steer, remove, and edit actions for queued prompts', () => {
    const onDeleteQueuedTurn = vi.fn()
    const onSteerQueuedTurn = vi.fn()
    renderComposer(vi.fn(), {
      running: true,
      canSteerQueue: true,
      queuedTurns: [
        {
          id: 'queued-1',
          text: 'Polish the queue',
          attachments: ['/work/reference.png'],
          createdAt: 1,
        },
      ],
      onDeleteQueuedTurn,
      onSteerQueuedTurn,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    expect(onSteerQueuedTurn).toHaveBeenCalledWith('queued-1')

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Polish the queue' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit prompt' }))
    expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
      'Polish the queue',
    )
    expect(onDeleteQueuedTurn).toHaveBeenCalledWith('queued-1')
  })
})

describe('Composer permissions', () => {
  it('offers auto-review only when the selected provider supports it', () => {
    const unsupported = renderComposer(vi.fn())
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.queryByRole('menuitem', { name: /Auto-review/ })).toBeNull()

    unsupported.unmount()
    renderComposer(vi.fn(), { autoReviewSupported: true })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.getByRole('menuitem', { name: /Auto-review/ })).toBeTruthy()
  })
})

function renderComposer(
  onSend: (text: string, attachments: string[]) => void,
  overrides: Partial<Parameters<typeof Composer>[0]> = {},
) {
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
      disabled={false}
      running={false}
      newSession
      isolate={false}
      focusRequest={0}
      queuedTurns={[]}
      canSteerQueue={false}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onServiceTierChange={vi.fn()}
      onApprovalChange={vi.fn()}
      onIsolateChange={vi.fn()}
      onProjectChange={vi.fn()}
      onBranchChange={vi.fn()}
      onSend={onSend}
      onInterrupt={vi.fn()}
      onDeleteQueuedTurn={vi.fn()}
      onSteerQueuedTurn={vi.fn()}
      {...overrides}
    />,
  )
}
