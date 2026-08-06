// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from './Composer.js'

const bridge = vi.hoisted(() => ({
  savePastedImage: vi.fn(),
}))

vi.mock('../bridge.js', () => ({
  pickFiles: vi.fn(async () => []),
  savePastedImage: bridge.savePastedImage,
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
  it('changes Stop to Queue when a running session has a draft and Enter queues it', () => {
    const onSend = vi.fn()
    const onInterrupt = vi.fn()
    renderComposer(onSend, { running: true, onInterrupt })
    const composer = screen.getByPlaceholderText('Do anything')

    const action = screen.getByRole('button', { name: 'Stop' })
    fireEvent.change(composer, { target: { value: 'Do this next' } })
    expect(screen.getByRole('button', { name: 'Queue' })).toBe(action)
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('Do this next', [])
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBe(action)
    expect(action.classList.contains('is-sending')).toBe(true)
  })

  it('steers a running session with Ctrl+Enter', () => {
    const onSend = vi.fn()
    const onSteer = vi.fn()
    renderComposer(onSend, { running: true, canSteerQueue: true, onSteer })
    const composer = screen.getByPlaceholderText('Do anything')

    fireEvent.change(composer, { target: { value: 'Use this direction now' } })
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })

    expect(onSteer).toHaveBeenCalledWith('Use this direction now', [])
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByText('Next message')).toBeNull()
  })

  it('offers reorder, steer, remove, and edit actions for queued prompts', () => {
    const onDeleteQueuedTurn = vi.fn()
    const onMoveQueuedTurn = vi.fn()
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
        {
          id: 'queued-2',
          text: 'Run the tests',
          attachments: [],
          createdAt: 2,
        },
      ],
      onDeleteQueuedTurn,
      onMoveQueuedTurn,
      onSteerQueuedTurn,
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'Steer' })[0]!)
    expect(onSteerQueuedTurn).toHaveBeenCalledWith('queued-1')

    fireEvent.click(screen.getByRole('button', { name: 'Move Run the tests up' }))
    expect(onMoveQueuedTurn).toHaveBeenCalledWith('queued-2', 'up')

    fireEvent.click(screen.getByRole('button', { name: 'Edit Polish the queue' }))
    expect((screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement).value).toBe(
      'Polish the queue',
    )
    expect(onDeleteQueuedTurn).toHaveBeenCalledWith('queued-1')
  })
})

describe('Composer permissions', () => {
  it('shows an icon for every mode and offers auto-review only when supported', () => {
    const unsupported = renderComposer(vi.fn())
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.queryByRole('menuitem', { name: /Auto-review/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Ask first/ }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Auto-approve/ }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Full access/ }).querySelector('svg')).toBeTruthy()

    unsupported.unmount()
    renderComposer(vi.fn(), { autoReviewSupported: true })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    const autoApprove = screen.getByRole('menuitem', { name: /Auto-approve/ })
    const autoReview = screen.getByRole('menuitem', { name: /Auto-review/ })
    expect(autoApprove.querySelector('.lucide-shield-check')).toBeTruthy()
    expect(autoReview.querySelector('.lucide-scan-eye')).toBeTruthy()
    expect(autoReview.classList.contains('composer__permission-option--auto-review')).toBe(true)
    expect(
      screen
        .getByRole('menuitem', { name: /Full access/ })
        .classList.contains('composer__permission-option--full'),
    ).toBe(true)
  })

  it('colors the selected auto-review and full-access triggers', () => {
    const autoReview = renderComposer(vi.fn(), {
      approval: 'auto-review',
      autoReviewSupported: true,
    })
    expect(
      screen.getByRole('button', { name: 'Permissions' }).querySelector('.tool--review'),
    ).toBeTruthy()

    autoReview.unmount()
    renderComposer(vi.fn(), { approval: 'full' })
    expect(
      screen.getByRole('button', { name: 'Permissions' }).querySelector('.tool--danger'),
    ).toBeTruthy()
  })
})

describe('Composer Design mode', () => {
  it('exposes a pressed toggle through its callback', () => {
    const onDesignModeChange = vi.fn()
    const view = renderComposer(vi.fn(), { onDesignModeChange })

    const design = screen.getByRole('button', { name: 'Design' })
    expect(design.getAttribute('aria-pressed')).toBe('false')
    expect(design.closest('.composer__design-beam')?.hasAttribute('data-active')).toBe(false)
    expect(design.closest('.composer__design-button-beam')?.hasAttribute('data-active')).toBe(false)
    fireEvent.click(design)
    expect(onDesignModeChange).toHaveBeenCalledWith(true)

    view.unmount()
    renderComposer(vi.fn(), { designMode: true })
    const activeDesign = screen.getByRole('button', { name: 'Design' })
    expect(activeDesign.getAttribute('aria-pressed')).toBe('true')
    expect(activeDesign.closest('.composer__design-beam')?.hasAttribute('data-active')).toBe(true)
    expect(activeDesign.closest('.composer__design-button-beam')?.hasAttribute('data-active')).toBe(
      true,
    )
  })
})

describe('Composer project requirement', () => {
  it('keeps the draft when send is blocked without a project', () => {
    const onSend = vi.fn()
    const onProjectRequired = vi.fn()
    renderComposer(onSend, {
      projects: [],
      projectPath: undefined,
      projectName: undefined,
      onProjectRequired,
    })
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: 'Keep this prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onProjectRequired).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
    expect(composer.value).toBe('Keep this prompt')
  })
})

describe('Composer height', () => {
  it('starts at two lines and scrolls only after ten lines', async () => {
    renderComposer(vi.fn())
    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    let contentHeight = 120
    Object.defineProperty(composer, 'offsetHeight', { configurable: true, value: 68 })
    Object.defineProperty(composer, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    })

    expect(composer.getAttribute('rows')).toBe('2')
    fireEvent.change(composer, { target: { value: 'one\ntwo\nthree' } })
    await waitFor(() => expect(composer.style.height).toBe('120px'))
    expect(composer.style.overflowY).toBe('hidden')

    contentHeight = 300
    fireEvent.change(composer, {
      target: { value: Array.from({ length: 11 }, () => 'line').join('\n') },
    })
    await waitFor(() => expect(composer.style.height).toBe('242px'))
    expect(composer.style.overflowY).toBe('auto')
  })
})

describe('Composer context usage', () => {
  it('shows exact context details on the compact ring', () => {
    renderComposer(vi.fn(), {
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 0,
        outputTokens: 3_000,
        reasoningTokens: 0,
        totalTokens: 15_000,
        contextWindow: 100_000,
      },
    })

    expect(screen.getByRole('img', { name: /context tokens used \(15%\)/ })).toBeTruthy()
    expect(screen.getByRole('tooltip').textContent).toContain('15% context used')
  })
})

describe('Composer branch shelf', () => {
  it('shows the branch picker only when the project has branches', () => {
    renderComposer(vi.fn())
    expect(screen.getByRole('button', { name: 'Choose branch' })).toBeTruthy()

    cleanup()
    renderComposer(vi.fn(), { branch: undefined, branches: [] })
    expect(screen.queryByRole('button', { name: 'Choose branch' })).toBeNull()
  })
})

describe('Composer draft replacement', () => {
  it('loads a previous prompt for editing and focuses it', async () => {
    renderComposer(vi.fn(), {
      draftRequest: { text: 'Rewrite this request', request: 1 },
    })

    const composer = screen.getByPlaceholderText('Do anything') as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe('Rewrite this request'))
    expect(document.activeElement).toBe(composer)
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
      voiceAvailable={false}
      disabled={false}
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
      onTranscribeVoice={vi.fn()}
      onCancelVoice={vi.fn()}
      onProjectChange={vi.fn()}
      onBranchChange={vi.fn()}
      onProjectRequired={vi.fn()}
      onSend={onSend}
      onSteer={vi.fn()}
      onInterrupt={vi.fn()}
      onDeleteQueuedTurn={vi.fn()}
      onMoveQueuedTurn={vi.fn()}
      onSteerQueuedTurn={vi.fn()}
      {...overrides}
    />,
  )
}
